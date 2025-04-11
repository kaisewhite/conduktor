import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { addStandardTags } from "../../../../helpers/tag_resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from "aws-cdk-lib/aws-efs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as backup from "aws-cdk-lib/aws-backup";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ecr from "aws-cdk-lib/aws-ecr";
const mgmt = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

/**
 * Configuration properties for the PostgreSQL Stack
 */
export interface ConduktorStackProps extends cdk.StackProps {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly domain: string;
  readonly subdomain: string;
  readonly vpcId: string;
  readonly memoryLimitMiB: number;
  readonly cpu: number;
  readonly desiredCount: number;
  readonly whitelist?: Array<{ address: string; description: string }>;
  readonly targetGroupPriority?: number;
  readonly healthCheck: string;
}

/**
 * Stack that deploys a PostgreSQL database using ECS Fargate with:
 * - EFS for persistent storage with automatic backups
 * - Network Load Balancer for direct TCP access
 * - Security groups for access control
 * - CloudWatch logging
 * - Route53 DNS records
 */
export class ConduktorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConduktorStackProps) {
    super(scope, id, props);

    // *********************************************
    // Core Infrastructure Setup
    // *********************************************
    const prefix = `${props.environment}-${props.project}-${props.service}`;
    const vpc = ec2.Vpc.fromLookup(this, `importing-${prefix}-vpc`, {
      isDefault: false,
      vpcId: props.vpcId,
    });



    // Stack tagging configuration
    const taggingProps = {
      project: props.project,
      service: props.service,
      environment: props.environment,
      prefix: prefix,
      customTags: {
        ...(props.tags || {}),
        Stack: "fargate",
      },
    };

    // Add tags to the stack itself
    addStandardTags(this, taggingProps);

    // *********************************************
    // IAM Role Configuration
    // *********************************************
    const role = new iam.Role(this, `${prefix}-role`, {
      assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("ecs-tasks.amazonaws.com"), new iam.ServicePrincipal("ecs.amazonaws.com")),
      roleName: `${prefix}-role`,
    });
    addStandardTags(role, taggingProps);

    // Grant AWS service permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: ["logs:*", "s3:*", "kms:*", "ecr:*", "ecs:*", "rds:*", "secretsmanager:*", "iam:PassRole", "elasticfilesystem:*"],
      })
    );

    // *********************************************
    // ECS Cluster Configuration
    // *********************************************
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, `import-${prefix}-fargate-cluster`, {
      clusterName: `${props.project}`,
      vpc: vpc,
      securityGroups: [],
    });

    // *********************************************
    // Security Group Configuration
    // *********************************************
    // Main security group for PostgreSQL service
    const fargateSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-postgres-sg`, {
      vpc: vpc,
      description: `Security group for Postgres service in ${props.environment}`,
      allowAllOutbound: true,
      securityGroupName: `${prefix}-postgres`,
    });
    addStandardTags(fargateSecurityGroup, taggingProps);

    // Configure inbound rules
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), "Allow HTTP from within VPC");
    fargateSecurityGroup.addIngressRule(fargateSecurityGroup, ec2.Port.tcp(5432), "Allow PostgreSQL from self");

    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8080), "Allow HTTP from within VPC");
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(8080), `Allow conduktor console port for management vpc`);

    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow ICMP from within VPC");

    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), `Allow TCP Traffic for ${vpc.vpcId}`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), `Allow TCP Traffic for ${vpc.vpcId}`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allIcmp(), "Allow all ICMP traffic");
    fargateSecurityGroup.addIngressRule(fargateSecurityGroup, ec2.Port.tcp(5432), `Allow traffic from self on postgres port`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(5432), `Allow postgres port for management vpc`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(80), `Allow TCP Traffic for management vpc`);
    fargateSecurityGroup.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.allIcmp(), `Allow ICMP Ping for management vpc`);

    const conduktorPorts = [8080, 9090, 9010, 9009, 9095];

    conduktorPorts.forEach((port) => {
      fargateSecurityGroup.addIngressRule(fargateSecurityGroup, ec2.Port.tcp(port), `Allow traffic from self on port ${port}`);
    });



    // *********************************************
    // EFS Storage Configuration
    // *********************************************
    // Security group for EFS access
    const postgresEfsSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-postgres-efs-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-postgres-efs`,
      description: `Security group for EFS mount targets in ${props.environment}`,
    });
    addStandardTags(postgresEfsSecurityGroup, taggingProps);

    // Configure EFS security rules
    postgresEfsSecurityGroup.addIngressRule(fargateSecurityGroup, ec2.Port.tcp(2049), "Allow NFS from Fargate tasks");
    postgresEfsSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049), "Allow NFS from VPC");

    // Tag EFS security group
    cdk.Tags.of(postgresEfsSecurityGroup).add("environment", prefix);
    cdk.Tags.of(postgresEfsSecurityGroup).add("Name", `${prefix}-postgres-efs`);

    // *********************************************
    // Secrets Configuration
    // *********************************************
    const secrets = new secretsmanager.Secret(this, `${prefix}-secret`, {
      secretName: `${prefix}`,
      secretObjectValue: {
        POSTGRES_USER: cdk.SecretValue.unsafePlainText(""),
        POSTGRES_PASSWORD: cdk.SecretValue.unsafePlainText(""),
        POSTGRES_DB: cdk.SecretValue.unsafePlainText(""),
        POSTGRES_PORT: cdk.SecretValue.unsafePlainText("5432"),
        CDK_ADMIN_EMAIL: cdk.SecretValue.unsafePlainText(""),
        CDK_ADMIN_PASSWORD: cdk.SecretValue.unsafePlainText(""),
        CDK_DATABASE_NAME: cdk.SecretValue.unsafePlainText(""),
        CDK_DATABASE_PASSWORD: cdk.SecretValue.unsafePlainText(""),
        CDK_DATABASE_PORT: cdk.SecretValue.unsafePlainText("5432"),
        CDK_DATABASE_USERNAME: cdk.SecretValue.unsafePlainText(""),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // encryptionKey: kmsKey,
      description: `Environment Variables for ${props.service}`,
    });
    addStandardTags(secrets, taggingProps);





    // *********************************************
    // Conduktor Configuration
    // *********************************************

    // Create EFS filesystem
    const fileSystem = new efs.FileSystem(this, `${prefix}-postgres-database-filesystem`, {
      vpc: vpc,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      encrypted: true,
      fileSystemName: `${prefix}-postgres-database`,
      securityGroup: postgresEfsSecurityGroup,
      enableAutomaticBackups: false,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
    });
    fileSystem.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    addStandardTags(fileSystem, taggingProps);


    const accessPoint = new efs.AccessPoint(this, `${prefix}-access-point`, {
      fileSystem: fileSystem,
      path: "/postgresql",
      createAcl: {
        ownerGid: "999", // postgres user GID
        ownerUid: "999", // postgres user UID
        permissions: "755", // More restrictive permissions for the data directory
      },
      posixUser: {
        gid: "999",
        uid: "999",
        secondaryGids: ["999"]  // Ensure PostgreSQL has full access
      },
    });
    addStandardTags(accessPoint, taggingProps);

    // *********************************************
    // Task Definition Configuration
    // *********************************************
    // Configure EFS volume for task
    const efsVolume: ecs.Volume = {
      name: "efs-volume",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
        rootDirectory: "/",
      },
    };


    const conduktorTaskDefinition = new ecs.FargateTaskDefinition(this, `${prefix}-console-task-definition`, {
      family: `${prefix}-console`,
      executionRole: role,
      taskRole: role,
      memoryLimitMiB: 8192,
      cpu: 4096, // 2 vCPU total for the task
      volumes: [efsVolume],
    });
    addStandardTags(conduktorTaskDefinition, taggingProps);

    // Create container definition
    const databaseContainer = conduktorTaskDefinition.addContainer(`${prefix}-postgres-db-container`, {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/postgres:17.4"),
      memoryLimitMiB: 1024,
      cpu: 512,
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        PGDATA: "/var/lib/postgresql/data",
        POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
        POSTGRES_HOST_AUTH_METHOD: "scram-sha-256",
        POSTGRES_STOP_MODE: "smart",
        POSTGRES_SHUTDOWN_TIMEOUT: "300",
      },
      dockerLabels: {
        "STOPSIGNAL": "SIGTERM"
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_PASSWORD"),
        POSTGRES_USER: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_USER"),
        POSTGRES_DB: ecs.Secret.fromSecretsManager(secrets, "POSTGRES_DB"),
      },
      linuxParameters: new ecs.LinuxParameters(this, `${prefix}-postgres-linux-parameters`, {
        initProcessEnabled: true,
      }),
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: new logs.LogGroup(this, `${prefix}-postgres-logs`, {
          logGroupName: `/ecs/${prefix}-postgres`,
          retention: logs.RetentionDays.TWO_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "pg_isready -U postgres || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
      portMappings: [
        {
          name: "postgresql",
          hostPort: 5432,
          containerPort: 5432,
          protocol: ecs.Protocol.TCP,

        },
      ],
    });

    // Configure container mount points and parameters
    databaseContainer.addMountPoints({
      containerPath: "/var/lib/postgresql/data",
      readOnly: false,
      sourceVolume: efsVolume.name,
    });

    // Add ulimits for optimal PostgreSQL performance
    databaseContainer.addUlimits({
      name: ecs.UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536,
    });

    databaseContainer.addUlimits({
      name: ecs.UlimitName.NPROC,
      softLimit: 65536,
      hardLimit: 65536,
    });





    const conduktorConsoleContainer = conduktorTaskDefinition.addContainer(`${prefix}-console-container`, {
      image: ecs.ContainerImage.fromRegistry("conduktor/conduktor-console:latest"),
      memoryLimitMiB: 3072, // 3GB of the 4GB total
      cpu: 1536, // 1.5 vCPU (1536 of 2048)
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      secrets: {
        CDK_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(secrets, "CDK_ADMIN_EMAIL"),
        CDK_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "CDK_ADMIN_PASSWORD"),
        CDK_DATABASE_NAME: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_NAME"),
        CDK_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_PASSWORD"),
        CDK_DATABASE_USERNAME: ecs.Secret.fromSecretsManager(secrets, "CDK_DATABASE_USERNAME"),
      },
      healthCheck: {
        command: ["CMD-SHELL", "curl -s  http://localhost:8080/api/health/live || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
      environment: {
        CDK_DATABASE_HOST: 'localhost',
        CDK_DATABASE_PORT: "5432",
        "CDK_MONITORING_ALERT-MANAGER-URL": "http://localhost:9010/",
        "CDK_MONITORING_CALLBACK-URL": "http://localhost:8080/monitoring/api/",
        "CDK_MONITORING_CORTEX-URL": "http://localhost:9009/",
        "CDK_MONITORING_NOTIFICATIONS-CALLBACK-URL": "http://localhost:8080",
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: new logs.LogGroup(this, `${prefix}-console-logs`, {
          logGroupName: `/ecs/${prefix}-console`,
          retention: logs.RetentionDays.TWO_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      portMappings: [
        {
          name: "console-8080-tcp",
          hostPort: 8080,
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    conduktorConsoleContainer.addContainerDependencies({ container: databaseContainer, condition: ecs.ContainerDependencyCondition.HEALTHY })

    // *********************************************
    // conduktorMonitoring Configuration
    // *********************************************

    const conduktorMonitoringContainer = conduktorTaskDefinition.addContainer(`${prefix}-monitoring-container`, {
      image: ecs.ContainerImage.fromRegistry("conduktor/conduktor-console-cortex:latest"),
      memoryLimitMiB: 1024, // 1GB of the 4GB total
      cpu: 512, // 0.5 vCPU (512 of 2048)
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      healthCheck: {
        command: ["CMD-SHELL", "curl -s http://localhost:9009/ready || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
      environment: {
        "CDK_CONSOLE-URL": `http://localhost:8080`,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        logGroup: new logs.LogGroup(this, `${prefix}-monitoring-logs`, {
          logGroupName: `/ecs/${prefix}-monitoring`,
          retention: logs.RetentionDays.TWO_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        multilinePattern: "^(INFO|DEBUG|WARN|ERROR|CRITICAL)",
      }),
      portMappings: [
        {
          name: "console-9090-tcp",
          hostPort: 9090,
          containerPort: 9090,
          protocol: ecs.Protocol.TCP,
        },
        {
          name: "conduktor-cortex-9010-tcp",
          hostPort: 9010,
          containerPort: 9010,
          protocol: ecs.Protocol.TCP,
        },
        {
          name: "conduktor-cortex-9009-tcp",
          hostPort: 9009,
          containerPort: 9009,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    // *********************************************
    // Fargate Service Configuration
    // *********************************************
    const conduktorService = new ecs.FargateService(this, `${prefix}-service`, {
      cluster: ecsCluster,
      taskDefinition: conduktorTaskDefinition,
      assignPublicIp: false,
      desiredCount: 1,
      securityGroups: [fargateSecurityGroup],
      healthCheckGracePeriod: cdk.Duration.seconds(300),
      vpcSubnets: {
        subnets: vpc.privateSubnets,
        availabilityZones: vpc.availabilityZones,
      },
      serviceName: `${props.service}`,
    });
    // Ensure service depends on EFS
    conduktorService.node.addDependency(fileSystem);
    addStandardTags(conduktorService, taggingProps);



    // *********************************************
    // EventBridge Rules for ecs-service Service
    // *********************************************
    // Start Fargate Service service at 05:00 EST (10:00 UTC)
    const startRule = new events.Rule(this, `${prefix}-start-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "14", // 10:00 UTC = 05:00 EST
        month: "*",
        day: "*",
      }),
      enabled: false,
      ruleName: `${prefix}-start-ecs-service`,
      description: `Start Fargate Service service at 05:00 EST (10:00 UTC)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${conduktorService.serviceName}`,
            desiredCount: 1,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [conduktorService.serviceArn],
          }),
        }),

      ],
    });
    addStandardTags(startRule, taggingProps);

    // Stop ecs-service service at 23:00 EST (04:00 UTC next day)
    const stopRule = new events.Rule(this, `${prefix}-stop-ecs-service-rule`, {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2", // 04:00 UTC = 10:00 EST (previous day)
        month: "*",
        day: "*",
      }),
      ruleName: `${props.service}-stop-ecs-service`,
      description: `Stop ecs-service service at 23:00 EST (04:00 UTC next day)`,
      targets: [
        new targets.AwsApi({
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: ecsCluster.clusterName,
            service: `${conduktorService.serviceName}`,
            desiredCount: 0,
          },
          catchErrorPattern: "ServiceNotFoundException",
          policyStatement: new iam.PolicyStatement({
            actions: ["ecs:UpdateService"],
            resources: [conduktorService.serviceArn],
          }),
        }),

      ],
    });
    addStandardTags(stopRule, taggingProps);
  }
}
