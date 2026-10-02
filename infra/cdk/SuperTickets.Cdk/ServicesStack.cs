using Amazon.CDK;
using Amazon.CDK.AWS.EC2;
using Amazon.CDK.AWS.Ecr.Assets;
using Amazon.CDK.AWS.ECS;
using Amazon.CDK.AWS.ElasticLoadBalancingV2;
using Amazon.CDK.AWS.IAM;
using Amazon.CDK.AWS.Logs;
using Amazon.CDK.AWS.SecretsManager;
using Amazon.CDK.AWS.SNS;
using Amazon.CDK.AWS.SQS;
using Constructs;

namespace SuperTickets.Cdk;

public class ServicesStackProps : StackProps
{
    public required DataStack Data { get; init; }
    public required MessagingStack Messaging { get; init; }
}

/// <summary>ECS cluster, 4 Fargate services, admin secret, internal ALB + rules, IAM, logs.</summary>
public class ServicesStack : Stack
{
    /// <summary>Internal ALB; T15 targets its listener from the VPC Link.</summary>
    public IApplicationLoadBalancer LoadBalancer { get; }
    /// <summary>Port 80 listener (default action: 404). T15's VPC Link integration uses this.</summary>
    public IApplicationListener Listener { get; }

    private readonly ServicesStackProps _p;
    private readonly Cluster _cluster;
    private readonly ISecret _adminKey;
    private readonly string _repoRoot;

    public ServicesStack(Construct scope, string id, ServicesStackProps props) : base(scope, id, props)
    {
        _p = props;
        // The Docker build context is the repo root: the nearest parent holding SuperTickets.slnx.
        var root = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "SuperTickets.slnx"))) root = root.Parent;
        _repoRoot = root?.FullName ?? throw new InvalidOperationException("Repo root (SuperTickets.slnx) not found");
        var data = props.Data;
        var tasksSg = data.TasksSecurityGroup;

        _cluster = new Cluster(this, "Cluster", new ClusterProps { Vpc = data.Vpc });
        _adminKey = new Amazon.CDK.AWS.SecretsManager.Secret(this, "AdminApiKey", new SecretProps
        {
            GenerateSecretString = new SecretStringGenerator { ExcludePunctuation = true, PasswordLength = 32 },
        });

        var alb = new ApplicationLoadBalancer(this, "Alb", new ApplicationLoadBalancerProps
        {
            Vpc = data.Vpc,
            InternetFacing = false,
            VpcSubnets = new SubnetSelection { SubnetType = SubnetType.PRIVATE_WITH_EGRESS },
            SecurityGroup = data.AlbSecurityGroup,
        });
        var listener = alb.AddListener("Http", new BaseApplicationListenerProps
        {
            Port = 80,
            Protocol = ApplicationProtocol.HTTP,
            Open = false,
            DefaultAction = ListenerAction.FixedResponse(404, new FixedResponseOptions
            {
                ContentType = "text/plain",
                MessageBody = "Not Found",
            }),
        });
        LoadBalancer = alb;
        Listener = listener;

        var inventoryUrl = $"http://{alb.LoadBalancerDnsName}";
        var region = Aws.REGION;

        var dbEnv = (string db) => new Dictionary<string, string>
        {
            [$"ConnectionStrings__{db}"] = $"Host={data.Database.DbInstanceEndpointAddress};Database={db.ToLowerInvariant()};Username=postgres",
            ["Services__InventoryUrl"] = inventoryUrl,
        };

        var catalogEnv = dbEnv("Catalog");
        catalogEnv["ConnectionStrings__Redis"] = $"{data.RedisEndpoint}:{data.RedisPort}";
        var catalog = AddService("Catalog", "Catalog.Api", 2, catalogEnv,
            new Dictionary<string, Amazon.CDK.AWS.ECS.Secret>
            {
                ["Admin__ApiKey"] = Amazon.CDK.AWS.ECS.Secret.FromSecretsManager(_adminKey),
            });
        var inventory = AddService("Inventory", "Inventory.Api", 1, dbEnv("Inventory"));

        var orderEnv = dbEnv("Orders");
        orderEnv["AWS_REGION"] = region;
        orderEnv["Messaging__TopicArn"] = props.Messaging.Topic.TopicArn;
        var order = AddService("Order", "Order.Api", 1, orderEnv);
        props.Messaging.Topic.GrantPublish(order.TaskDefinition.TaskRole);

        var workerEnv = dbEnv("Orders");
        workerEnv["AWS_REGION"] = region;
        workerEnv["Messaging__PaymentQueueUrl"] = props.Messaging.PaymentQueue.QueueUrl;
        workerEnv["Messaging__NotificationQueueUrl"] = props.Messaging.NotificationQueue.QueueUrl;
        var worker = AddService("Worker", "Worker", 1, workerEnv, ingress: false);
        foreach (var q in new IQueue[] { props.Messaging.PaymentQueue, props.Messaging.NotificationQueue })
        {
            worker.TaskDefinition.TaskRole.AddToPrincipalPolicy(new PolicyStatement(new PolicyStatementProps
            {
                Actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
                Resources = [q.QueueArn],
            }));
        }

        // Priorities 1-4 per aws-publish.md#routing.
        Rule("Inventory", 1, [PathCondition("/events/*/availability")], Target(inventory, "Inventory"));
        Rule("InventoryDirect", 2, [PathCondition("/inventory/*")], Target(inventory, "Inventory"));
        Rule("Catalog", 3, [PathCondition("/events", "/events/*", "/admin/*")], Target(catalog, "Catalog"));
        Rule("Order", 4, [PathCondition("/orders", "/orders/*")], Target(order, "Order"));

        void Rule(string name, int priority, ListenerCondition[] conditions, IApplicationTargetGroup tg) =>
            _ = new ApplicationListenerRule(this, $"{name}Rule", new ApplicationListenerRuleProps
            {
                Listener = listener,
                Priority = priority,
                Conditions = conditions,
                Action = ListenerAction.Forward([tg]),
            });
        ListenerCondition PathCondition(params string[] paths) => ListenerCondition.PathPatterns(paths);
        IApplicationTargetGroup Target(FargateService svc, string name) => TargetGroupFor(svc, name);
    }

    private readonly Dictionary<string, IApplicationTargetGroup> _targetGroups = new();

    // Rules 1 and 2 share the Inventory target group.
    private IApplicationTargetGroup TargetGroupFor(FargateService svc, string name)
    {
        if (_targetGroups.TryGetValue(name, out var existing)) return existing;
        var tg = new ApplicationTargetGroup(this, $"{name}Tg", new ApplicationTargetGroupProps
        {
            Vpc = _p.Data.Vpc,
            Port = 8080,
            Protocol = ApplicationProtocol.HTTP,
            TargetType = Amazon.CDK.AWS.ElasticLoadBalancingV2.TargetType.IP,
            Targets = [svc],
            DeregistrationDelay = Duration.Seconds(10),
            HealthCheck = new Amazon.CDK.AWS.ElasticLoadBalancingV2.HealthCheck
            {
                Path = "/health",
                Port = "8080",
                HealthyThresholdCount = 2,
                Interval = Duration.Seconds(15),
            },
        });
        _targetGroups[name] = tg;
        return tg;
    }

    private FargateService AddService(
        string name, string project, int count,
        Dictionary<string, string> env,
        Dictionary<string, Amazon.CDK.AWS.ECS.Secret>? secrets = null,
        bool ingress = true)
    {
        var task = new FargateTaskDefinition(this, $"{name}Task", new FargateTaskDefinitionProps
        {
            Cpu = 256,
            MemoryLimitMiB = 512,
            RuntimePlatform = new RuntimePlatform
            {
                CpuArchitecture = CpuArchitecture.X86_64,
                OperatingSystemFamily = OperatingSystemFamily.LINUX,
            },
        });

        var allSecrets = new Dictionary<string, Amazon.CDK.AWS.ECS.Secret>
        {
            ["PGPASSWORD"] = Amazon.CDK.AWS.ECS.Secret.FromSecretsManager(_p.Data.DatabaseSecret, "password"),
        };
        if (secrets is not null) foreach (var kv in secrets) allSecrets[kv.Key] = kv.Value;

        task.AddContainer("app", new ContainerDefinitionOptions
        {
            Image = ContainerImage.FromAsset(_repoRoot, new AssetImageProps
            {
                File = $"src/{project}/Dockerfile",
                Platform = Platform_LinuxAmd64(),
            }),
            Environment = env,
            Secrets = allSecrets,
            PortMappings = ingress ? [new PortMapping { ContainerPort = 8080 }] : [],
            Logging = LogDriver.AwsLogs(new AwsLogDriverProps
            {
                StreamPrefix = name.ToLowerInvariant(),
                LogGroup = new LogGroup(this, $"{name}Logs", new LogGroupProps
                {
                    Retention = RetentionDays.ONE_WEEK,
                    RemovalPolicy = RemovalPolicy.DESTROY,
                }),
            }),
        });

        return new FargateService(this, $"{name}Service", new FargateServiceProps
        {
            Cluster = _cluster,
            TaskDefinition = task,
            DesiredCount = count,
            AssignPublicIp = false,
            VpcSubnets = new SubnetSelection { SubnetType = SubnetType.PRIVATE_WITH_EGRESS },
            SecurityGroups = [_p.Data.TasksSecurityGroup],
            MinHealthyPercent = 100,
        });
    }

    private static Amazon.CDK.AWS.Ecr.Assets.Platform_ Platform_LinuxAmd64() =>
        Amazon.CDK.AWS.Ecr.Assets.Platform_.LINUX_AMD64;
}
