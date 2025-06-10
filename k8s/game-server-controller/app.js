const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const k8s = require('@kubernetes/client-node');
const prometheus = require('prom-client');
const winston = require('winston');

// Initialize Kubernetes client
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);

// Initialize Express app
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'game-server-controller.log' })
  ]
});

// Prometheus metrics
const register = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register });

const gameServerMetrics = {
  activeServers: new prometheus.Gauge({
    name: 'game_servers_active_total',
    help: 'Total number of active game servers',
    registers: [register]
  }),
  playerConnections: new prometheus.Gauge({
    name: 'game_servers_player_connections_total',
    help: 'Total number of player connections across all servers',
    registers: [register]
  }),
  serverRequests: new prometheus.Counter({
    name: 'game_server_requests_total',
    help: 'Total number of game server requests',
    labelNames: ['method', 'status'],
    registers: [register]
  })
};

// Game server state management
class GameServerController {
  constructor() {
    this.servers = new Map();
    this.players = new Map();
    this.namespace = process.env.NAMESPACE || 'game-servers';
    this.maxPlayersPerServer = parseInt(process.env.MAX_PLAYERS_PER_SERVER) || 100;
    this.minServers = parseInt(process.env.MIN_SERVERS) || 2;
    this.maxServers = parseInt(process.env.MAX_SERVERS) || 10;
  }

  async initialize() {
    logger.info('Initializing Game Server Controller');
    await this.discoverExistingServers();
    await this.ensureMinimumServers();
    this.startHealthChecks();
    this.startMetricsCollection();
  }

  async discoverExistingServers() {
    try {
      const pods = await k8sApi.listNamespacedPod(this.namespace, undefined, undefined, undefined, undefined, 'app=game-server-instance');
      
      for (const pod of pods.body.items) {
        if (pod.status.phase === 'Running') {
          const serverInfo = {
            id: pod.metadata.name,
            ip: pod.status.podIP,
            port: 3000,
            players: 0,
            status: 'running',
            createdAt: new Date(pod.metadata.creationTimestamp)
          };
          this.servers.set(serverInfo.id, serverInfo);
          logger.info(`Discovered existing server: ${serverInfo.id}`);
        }
      }
    } catch (error) {
      logger.error('Error discovering existing servers:', error);
    }
  }

  async createGameServer() {
    const serverId = `game-server-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: serverId,
        namespace: this.namespace,
        labels: {
          app: 'game-server-instance',
          'managed-by': 'game-server-controller'
        }
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'game-server-instance',
            'server-id': serverId
          }
        },
        template: {
          metadata: {
            labels: {
              app: 'game-server-instance',
              'server-id': serverId
            }
          },
          spec: {
            containers: [{
              name: 'game-server',
              image: 'game-server-instance:latest',
              ports: [{
                containerPort: 3000,
                name: 'game-port'
              }],
              env: [
                { name: 'SERVER_ID', value: serverId },
                { name: 'MAX_PLAYERS', value: this.maxPlayersPerServer.toString() }
              ],
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '256Mi'
                },
                limits: {
                  cpu: '500m',
                  memory: '512Mi'
                }
              },
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000
                },
                initialDelaySeconds: 10,
                periodSeconds: 5
              },
              livenessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000
                },
                initialDelaySeconds: 30,
                periodSeconds: 10
              }
            }]
          }
        }
      }
    };

    try {
      await appsApi.createNamespacedDeployment(this.namespace, deployment);
      
      const serverInfo = {
        id: serverId,
        status: 'starting',
        players: 0,
        createdAt: new Date()
      };
      
      this.servers.set(serverId, serverInfo);
      logger.info(`Created new game server: ${serverId}`);
      
      return serverInfo;
    } catch (error) {
      logger.error(`Error creating game server ${serverId}:`, error);
      throw error;
    }
  }

  async deleteGameServer(serverId) {
    try {
      await appsApi.deleteNamespacedDeployment(serverId, this.namespace);
      this.servers.delete(serverId);
      logger.info(`Deleted game server: ${serverId}`);
    } catch (error) {
      logger.error(`Error deleting game server ${serverId}:`, error);
    }
  }

  async ensureMinimumServers() {
    const runningServers = Array.from(this.servers.values()).filter(s => s.status === 'running');
    
    if (runningServers.length < this.minServers) {
      const serversToCreate = this.minServers - runningServers.length;
      logger.info(`Creating ${serversToCreate} servers to meet minimum requirement`);
      
      for (let i = 0; i < serversToCreate; i++) {
        await this.createGameServer();
      }
    }
  }

  findAvailableServer() {
    const availableServers = Array.from(this.servers.values())
      .filter(s => s.status === 'running' && s.players < this.maxPlayersPerServer)
      .sort((a, b) => a.players - b.players);
    
    return availableServers[0] || null;
  }

  async scaleServers() {
    const runningServers = Array.from(this.servers.values()).filter(s => s.status === 'running');
    const totalPlayers = runningServers.reduce((sum, server) => sum + server.players, 0);
    const averageLoad = totalPlayers / runningServers.length;
    
    // Scale up if average load is high
    if (averageLoad > this.maxPlayersPerServer * 0.8 && runningServers.length < this.maxServers) {
      logger.info('Scaling up: High server load detected');
      await this.createGameServer();
    }
    
    // Scale down if we have too many idle servers
    const idleServers = runningServers.filter(s => s.players === 0);
    if (idleServers.length > 1 && runningServers.length > this.minServers) {
      const serverToRemove = idleServers[0];
      logger.info(`Scaling down: Removing idle server ${serverToRemove.id}`);
      await this.deleteGameServer(serverToRemove.id);
    }
  }

  startHealthChecks() {
    setInterval(async () => {
      await this.scaleServers();
      this.updateMetrics();
    }, 30000); // Check every 30 seconds
  }

  startMetricsCollection() {
    setInterval(() => {
      this.updateMetrics();
    }, 10000); // Update metrics every 10 seconds
  }

  updateMetrics() {
    const runningServers = Array.from(this.servers.values()).filter(s => s.status === 'running');
    const totalPlayers = runningServers.reduce((sum, server) => sum + server.players, 0);
    
    gameServerMetrics.activeServers.set(runningServers.length);
    gameServerMetrics.playerConnections.set(totalPlayers);
  }
}

// Initialize controller
const controller = new GameServerController();

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/servers', (req, res) => {
  const servers = Array.from(controller.servers.values());
  res.json({ servers, count: servers.length });
});

app.post('/servers', async (req, res) => {
  gameServerMetrics.serverRequests.inc({ method: 'POST', status: 'success' });
  try {
    const server = await controller.createGameServer();
    res.json({ success: true, server });
  } catch (error) {
    gameServerMetrics.serverRequests.inc({ method: 'POST', status: 'error' });
    res.status(500).json({ error: error.message });
  }
});

app.delete('/servers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await controller.deleteGameServer(id);
    res.json({ success: true, message: `Server ${id} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO for real-time communication
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('request-server', async (data) => {
    const { playerId } = data;
    const availableServer = controller.findAvailableServer();
    
    if (availableServer) {
      socket.emit('server-assigned', {
        serverId: availableServer.id,
        serverIP: availableServer.ip,
        serverPort: availableServer.port
      });
      
      // Update player count
      availableServer.players++;
      controller.players.set(playerId, availableServer.id);
    } else {
      // No available servers, create a new one
      try {
        const newServer = await controller.createGameServer();
        socket.emit('server-assigned', {
          serverId: newServer.id,
          message: 'New server created, please retry in a moment'
        });
      } catch (error) {
        socket.emit('error', { message: 'Unable to assign server' });
      }
    }
  });
  
  socket.on('player-disconnect', (data) => {
    const { playerId } = data;
    const serverId = controller.players.get(playerId);
    
    if (serverId) {
      const server = controller.servers.get(serverId);
      if (server && server.players > 0) {
        server.players--;
      }
      controller.players.delete(playerId);
    }
  });
  
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  logger.info(`Game Server Controller listening on port ${PORT}`);
  await controller.initialize();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});