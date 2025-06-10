# Game Server Management on Kubernetes

This project provides a complete game server management solution deployed on AWS EKS (Elastic Kubernetes Service).

## Architecture Overview

- **Game Server Controller**: Manages game server instances, scaling, and lifecycle
- **Load Balancer**: Routes player connections to healthy game server instances
- **Metrics & Monitoring**: Prometheus and Grafana for monitoring server health
- **Auto-scaling**: Horizontal Pod Autoscaler based on CPU/Memory and custom metrics
- **Persistent Storage**: EBS volumes for game state persistence

## Components

### Core Services
- `game-server-controller/` - Main game server management service
- `game-server-instances/` - Individual game server pods
- `load-balancer/` - Traffic routing and load balancing
- `monitoring/` - Prometheus, Grafana, and alerting

### Infrastructure
- `infrastructure/` - Terraform configurations for AWS resources
- `k8s-manifests/` - Kubernetes deployment manifests
- `helm-charts/` - Helm charts for easy deployment
- `scripts/` - Deployment and management scripts

## Prerequisites

- AWS CLI configured with appropriate permissions
- kubectl installed and configured
- Helm 3.x installed
- Docker for building custom images
- Terraform for infrastructure provisioning

## Quick Start

1. Deploy infrastructure: `./scripts/deploy-infrastructure.sh`
2. Deploy Kubernetes resources: `./scripts/deploy-k8s.sh`
3. Monitor deployment: `kubectl get pods -n game-servers`

See individual component READMEs for detailed configuration options.