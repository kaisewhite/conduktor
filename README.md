# Conduktor on AWS

This repository contains AWS CDK code for deploying Conduktor Console on AWS. Conduktor is a comprehensive Kafka management platform that helps you monitor, manage, and optimize your Kafka clusters.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Infrastructure Components](#infrastructure-components)
- [Container Configuration](#container-configuration)
- [Security](#security)
- [Deployment Instructions](#deployment-instructions)
- [Schedule Configuration](#schedule-configuration)
- [Monitoring and Logging](#monitoring-and-logging)
- [Additional Resources](#additional-resources)

## Overview

This CDK stack deploys Conduktor Console on AWS using ECS Fargate with a three-container architecture. The deployment is fully managed through Infrastructure as Code, making it reproducible and maintainable.

Unlike the manual deployment approach documented in Conduktor's official guide, this CDK implementation automates the entire process and includes additional features like:

- Self-contained PostgreSQL database in the same ECS task
- Persistent storage using EFS
- Scheduled start/stop of the service to optimize costs
- Comprehensive security group configuration
- Centralized logging in CloudWatch

## Architecture

The deployment uses the following high-level architecture:

- **AWS ECS with Fargate**: Serverless container orchestration
- **Single ECS Task**: Contains all three containers
- **Amazon EFS**: For persistent PostgreSQL data storage
- **AWS Secrets Manager**: For secure credential management
- **AWS CloudWatch**: For centralized logging
- **EventBridge**: For scheduled start/stop of the service

### Architecture Diagram

```mermaid
graph TD
    classDef aws fill:#232F3E,stroke:#fff,stroke-width:2px
    classDef awsService fill:#FF9900,stroke:#fff,stroke-width:2px
    classDef awsResource fill:#527FFF,stroke:#fff,stroke-width:2px
    classDef external fill:#427AB3,stroke:#fff,stroke-width:2px
    classDef container fill:#2E8651,stroke:#fff,stroke-width:2px

    subgraph AWS_Cloud["AWS Cloud"]
        class AWS_Cloud aws
        subgraph VPC["VPC"]
            class VPC aws
            subgraph Private_Subnet["Private Subnet"]
                class Private_Subnet aws
                subgraph ECS_Cluster["ECS Cluster"]
                    class ECS_Cluster aws
                    subgraph Fargate_Task["Fargate Task"]
                        class Fargate_Task aws
                        PG[PostgreSQL Container] --> CONDUKTOR
                        CONDUKTOR[Conduktor Console Container] --> MONITORING
                        MONITORING[Monitoring Container]
                        class PG,CONDUKTOR,MONITORING container
                    end
                    EFS[Amazon EFS] --> PG
                    class EFS awsResource
                end
                SG[Security Group] --> Fargate
                class SG awsResource
            end
        end
        SECRETS[AWS Secrets Manager] --> Fargate
        LOGS[CloudWatch Logs] <-- Fargate
        EVENTS[EventBridge Rules] --> Fargate
        class SECRETS,LOGS,EVENTS awsService
    end
    KAFKA[Kafka Clusters] --> CONDUKTOR
    USER[Users] --> CONDUKTOR
    ADMIN[Administrators] --> CONDUKTOR
    class KAFKA,USER,ADMIN external

    style AWS_Cloud fill:#232F3E,stroke:#fff,stroke-width:2px,font-size:14px
    style VPC fill:#232F3E,stroke:#fff,stroke-width:2px,font-size:14px
    style Private_Subnet fill:#232F3E,stroke:#fff,stroke-width:2px,font-size:14px
    style ECS_Cluster fill:#232F3E,stroke:#fff,stroke-width:2px,font-size:14px
    style Fargate_Task fill:#232F3E,stroke:#fff,stroke-width:2px,font-size:14px

    linkStyle default stroke:#fff,stroke-width:2px
```

The diagram shows how the three containers interact within a single Fargate task, using EFS for persistence and connecting to external Kafka clusters for management.

## Infrastructure Components

The stack provisions the following AWS resources:

- **ECS Fargate Task**: A single task containing all three containers
- **EFS Filesystem**: For PostgreSQL data persistence
- **Security Groups**: For controlling network access
- **IAM Roles**: With least privilege permissions
- **CloudWatch Log Groups**: For container logging
- **EventBridge Rules**: For scheduling service operation

## Container Configuration

The deployment consists of three containers running within the same ECS task:

### 1. PostgreSQL Database Container

- **Image**: `public.ecr.aws/docker/library/postgres:17.4`
- **Purpose**: Provides the database backend for Conduktor Console
- **Resources**: 1024 MiB memory, 512 CPU units (0.5 vCPU)
- **Storage**: Data persisted on EFS mount
- **Ports**: 5432 (PostgreSQL)
- **Configuration**:
  - Optimized ulimit settings for PostgreSQL
  - Uses secrets from AWS Secrets Manager for credentials
  - Database data stored on persistent EFS volume

### 2. Conduktor Console Container

- **Image**: `conduktor/conduktor-console:latest`
- **Purpose**: Main application container that provides the Conduktor UI and core functionality
- **Resources**: 3072 MiB memory, 1536 CPU units (1.5 vCPU)
- **Dependencies**: Depends on PostgreSQL container being healthy
- **Ports**: 8080 (HTTP UI)
- **Configuration**:
  - Connects to the local PostgreSQL container
  - Uses secrets from AWS Secrets Manager for admin credentials
  - Configured with monitoring endpoints for the Cortex container

### 3. Conduktor Monitoring Container

- **Image**: `conduktor/conduktor-console-cortex:latest`
- **Purpose**: Provides monitoring and alerting functionality
- **Resources**: 1024 MiB memory, 512 CPU units (0.5 vCPU)
- **Ports**:
  - 9090 (Prometheus metrics)
  - 9010 (Alert manager)
  - 9009 (Cortex API)
- **Configuration**:
  - References the Conduktor Console container as its data source

## Security

The CDK stack implements several security best practices:

- **VPC Isolation**: Deployed into private subnets within a customer-specified VPC
- **Security Groups**: Configured with least privilege access
  - Internal container communication allowed
  - VPC CIDR allowed for Conduktor ports (8080, 9090, 9010, 9009)
  - Management VPC access allowed for administration
- **Secrets Management**: All credentials stored in AWS Secrets Manager
- **EFS Encryption**: Persistent storage is encrypted at rest
- **Least Privilege IAM**: Task roles with minimal required permissions

## Deployment Instructions

### Prerequisites

- AWS CDK installed and configured
- AWS CLI with appropriate permissions
- Existing VPC with public and private subnets

### Deployment Steps

1. Update the stack properties in your CDK app with your specific configuration:

```typescript
new ConduktorStack(app, 'ConduktorStack', {
  project: 'your-project',
  service: 'conduktor',
  environment: 'dev',
  domain: 'example.com',
  subdomain: 'conduktor',
  vpcId: 'vpc-xxxxxxxxxxxxxxxxx',
  memoryLimitMiB: 8192,
  cpu: 4096,
  desiredCount: 1,
  healthCheck: '/api/health/live',
});
```

2. Before deployment, update the secrets in AWS Secrets Manager with appropriate values for:
   - PostgreSQL credentials
   - Conduktor admin credentials

3. Deploy using CDK:

```bash
cdk deploy ConduktorStack
```

4. After deployment, access Conduktor Console via the task's IP address or DNS name on port 8080

## Schedule Configuration

The service includes EventBridge rules for automatic scheduling:

- **Start Schedule**: Configured to start the service at 05:00 EST (10:00 UTC)
- **Stop Schedule**: Configured to stop the service at 23:00 EST (04:00 UTC next day)

These schedules help optimize costs by running the service only during business hours. The schedules can be adjusted by modifying the EventBridge rules in the CDK code.

## Monitoring and Logging

All containers are configured with CloudWatch logging:

- **Log Groups**:
  - `/ecs/{prefix}-postgres`: PostgreSQL container logs
  - `/ecs/{prefix}-console`: Conduktor Console container logs
  - `/ecs/{prefix}-monitoring`: Monitoring container logs

- **Log Retention**: Configured for 2 months

## Additional Resources

- [Official Conduktor Documentation](https://docs.conduktor.io/)
- [Conduktor AWS Deployment Guide](https://docs.conduktor.io/platform/get-started/installation/get-started/AWS/)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/latest/guide/home.html)
- [Fargate Documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [EFS Documentation](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
