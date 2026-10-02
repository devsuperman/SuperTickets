using Amazon.CDK;
using Amazon.CDK.AWS.EC2;
using Amazon.CDK.AWS.ElastiCache;
using Amazon.CDK.AWS.RDS;
using Constructs;

namespace SuperTickets.Cdk;

/// <summary>VPC, NAT, security groups, RDS PostgreSQL (+ secret), ElastiCache Redis.</summary>
public class DataStack : Stack
{
    public IVpc Vpc { get; }
    public ISecurityGroup AlbSecurityGroup { get; }
    public ISecurityGroup VpcLinkSecurityGroup { get; }
    public ISecurityGroup TasksSecurityGroup { get; }
    public ISecurityGroup DbSecurityGroup { get; }
    public ISecurityGroup CacheSecurityGroup { get; }
    public IDatabaseInstance Database { get; }
    /// <summary>RDS-generated secret (JSON with username/password); ECS maps the password to PGPASSWORD.</summary>
    public Amazon.CDK.AWS.SecretsManager.ISecret DatabaseSecret { get; }
    public string RedisEndpoint { get; }
    public string RedisPort { get; }

    public DataStack(Construct scope, string id, IStackProps? props = null) : base(scope, id, props)
    {
        Vpc = new Vpc(this, "Vpc", new VpcProps
        {
            MaxAzs = 2,
            NatGateways = 1,
            SubnetConfiguration =
            [
                new SubnetConfiguration { Name = "public", SubnetType = SubnetType.PUBLIC, CidrMask = 24 },
                new SubnetConfiguration { Name = "private", SubnetType = SubnetType.PRIVATE_WITH_EGRESS, CidrMask = 24 },
            ],
        });

        var albSg = SecurityGroupFor("AlbSg", "alb-sg");
        var vpcLinkSg = SecurityGroupFor("VpcLinkSg", "vpc-link-sg");
        var tasksSg = SecurityGroupFor("TasksSg", "tasks-sg");
        var dbSg = SecurityGroupFor("DbSg", "db-sg");
        var cacheSg = SecurityGroupFor("CacheSg", "cache-sg");

        albSg.AddIngressRule(vpcLinkSg, Port.Tcp(80), "API Gateway VPC Link");
        albSg.AddIngressRule(tasksSg, Port.Tcp(80), "Service-to-service calls to Inventory");
        tasksSg.AddIngressRule(albSg, Port.Tcp(8080), "ALB to tasks");
        dbSg.AddIngressRule(tasksSg, Port.Tcp(5432), "Tasks to PostgreSQL");
        cacheSg.AddIngressRule(tasksSg, Port.Tcp(6379), "Tasks to Redis");

        AlbSecurityGroup = albSg;
        VpcLinkSecurityGroup = vpcLinkSg;
        TasksSecurityGroup = tasksSg;
        DbSecurityGroup = dbSg;
        CacheSecurityGroup = cacheSg;

        var db = new DatabaseInstance(this, "Postgres", new DatabaseInstanceProps
        {
            Engine = DatabaseInstanceEngine.Postgres(new PostgresInstanceEngineProps
            {
                Version = PostgresEngineVersion.VER_17,
            }),
            InstanceType = Amazon.CDK.AWS.EC2.InstanceType.Of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.MICRO),
            AllocatedStorage = 20,
            StorageType = StorageType.GP3,
            MultiAz = false,
            StorageEncrypted = true,
            Vpc = Vpc,
            VpcSubnets = new SubnetSelection { SubnetType = SubnetType.PRIVATE_WITH_EGRESS },
            SecurityGroups = [dbSg],
            Credentials = Credentials.FromGeneratedSecret("postgres"),
            PubliclyAccessible = false,
            BackupRetention = Duration.Days(1),
            DeletionProtection = false,
            RemovalPolicy = RemovalPolicy.DESTROY,
        });
        Database = db;
        DatabaseSecret = db.Secret!;

        var subnetGroup = new CfnSubnetGroup(this, "CacheSubnets", new CfnSubnetGroupProps
        {
            Description = "SuperTickets Redis",
            SubnetIds = Vpc.SelectSubnets(new SubnetSelection { SubnetType = SubnetType.PRIVATE_WITH_EGRESS }).SubnetIds,
        });
        var redis = new CfnCacheCluster(this, "Redis", new CfnCacheClusterProps
        {
            Engine = "redis",
            EngineVersion = "7.1",
            CacheNodeType = "cache.t4g.micro",
            NumCacheNodes = 1,
            CacheSubnetGroupName = subnetGroup.Ref,
            VpcSecurityGroupIds = [cacheSg.SecurityGroupId],
        });
        RedisEndpoint = redis.AttrRedisEndpointAddress;
        RedisPort = redis.AttrRedisEndpointPort;
    }

    private SecurityGroup SecurityGroupFor(string logicalId, string name) =>
        new(this, logicalId, new SecurityGroupProps
        {
            Vpc = Vpc,
            SecurityGroupName = name,
            Description = name,
            AllowAllOutbound = true,
        });
}
