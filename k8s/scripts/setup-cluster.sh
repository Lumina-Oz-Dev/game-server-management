#!/bin/bash

# Game Server Management - EKS Cluster Setup Script
# This script creates an EKS cluster optimized for game server workloads

set -e

# Configuration variables
CLUSTER_NAME="game-server-cluster"
REGION="us-west-2"
NODE_GROUP_NAME="game-server-nodes"
NODE_INSTANCE_TYPE="m5.large"
MIN_NODES=2
MAX_NODES=10
DESIRED_NODES=3

echo "🎮 Setting up EKS cluster for Game Server Management..."

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo "❌ AWS CLI not configured. Please run 'aws configure' first."
    exit 1
fi

# Check if eksctl is installed
if ! command -v eksctl &>/dev/null; then
    echo "❌ eksctl not found. Please install eksctl first."
    echo "   Visit: https://docs.aws.amazon.com/eks/latest/userguide/eksctl.html"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Create EKS cluster
echo "🚀 Creating EKS cluster: $CLUSTER_NAME"
eksctl create cluster \
    --name $CLUSTER_NAME \
    --region $REGION \
    --node-type $NODE_INSTANCE_TYPE \
    --nodes $DESIRED_NODES \
    --nodes-min $MIN_NODES \
    --nodes-max $MAX_NODES \
    --with-oidc \
    --ssh-access \
    --ssh-public-key ~/.ssh/id_rsa.pub \
    --managed

# Update kubeconfig
echo "📝 Updating kubeconfig..."
aws eks update-kubeconfig --region $REGION --name $CLUSTER_NAME

# Verify cluster connection
echo "🔍 Verifying cluster connection..."
kubectl get nodes

# Install AWS Load Balancer Controller
echo "⚖️ Installing AWS Load Balancer Controller..."
./install-alb-controller.sh

# Install Metrics Server
echo "📊 Installing Metrics Server..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Create game-servers namespace
echo "🎯 Creating game-servers namespace..."
kubectl create namespace game-servers || true
kubectl create namespace monitoring || true

echo "✅ EKS cluster setup completed successfully!"
echo "   Cluster Name: $CLUSTER_NAME"
echo "   Region: $REGION"
echo "   Nodes: $DESIRED_NODES ($MIN_NODES-$MAX_NODES)"
echo ""
echo "Next steps:"
echo "1. Deploy game server components: ./deploy-game-servers.sh"
echo "2. Set up monitoring: ./deploy-monitoring.sh"
echo "3. Configure auto-scaling: ./configure-hpa.sh"