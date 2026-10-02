using Amazon.CDK;
using Amazon.CDK.AWS.Apigatewayv2;
using Amazon.CDK.AWS.EC2;
using Constructs;

namespace SuperTickets.Cdk;

public class ApiStackProps : StackProps
{
    public required DataStack Data { get; init; }
    public required ServicesStack Services { get; init; }
}

/// <summary>HTTP API with the seven public routes, proxied through a VPC Link to the internal ALB listener.</summary>
public class ApiStack : Stack
{
    private static readonly string[] PublicRoutes =
    [
        "GET /events",
        "GET /events/{id}",
        "GET /events/{id}/availability",
        "POST /orders",
        "GET /orders/{id}",
        "POST /admin/events",
        "PUT /admin/events/{id}",
    ];

    /// <summary>API Gateway domain without scheme, for WebStack's origin.</summary>
    public string ApiDomain { get; }

    public ApiStack(Construct scope, string id, ApiStackProps props) : base(scope, id, props)
    {
        var api = new CfnApi(this, "HttpApi", new CfnApiProps
        {
            Name = "supertickets",
            ProtocolType = "HTTP",
        });

        var vpcLink = new CfnVpcLink(this, "VpcLink", new CfnVpcLinkProps
        {
            Name = "supertickets",
            SubnetIds = props.Data.Vpc.SelectSubnets(new SubnetSelection { SubnetType = SubnetType.PRIVATE_WITH_EGRESS }).SubnetIds,
            SecurityGroupIds = [props.Data.VpcLinkSecurityGroup.SecurityGroupId],
        });

        var integration = new CfnIntegration(this, "AlbIntegration", new CfnIntegrationProps
        {
            ApiId = api.Ref,
            IntegrationType = "HTTP_PROXY",
            IntegrationMethod = "ANY",
            ConnectionType = "VPC_LINK",
            ConnectionId = vpcLink.Ref,
            IntegrationUri = props.Services.Listener.ListenerArn,
            PayloadFormatVersion = "1.0",
        });

        var routes = PublicRoutes.Select((key, i) => new Amazon.CDK.AWS.Apigatewayv2.CfnRoute(this, $"Route{i}", new Amazon.CDK.AWS.Apigatewayv2.CfnRouteProps
        {
            ApiId = api.Ref,
            RouteKey = key,
            Target = $"integrations/{integration.Ref}",
        })).ToArray();

        var stage = new CfnStage(this, "DefaultStage", new CfnStageProps
        {
            ApiId = api.Ref,
            StageName = "$default",
            AutoDeploy = true,
            DefaultRouteSettings = new CfnStage.RouteSettingsProperty
            {
                ThrottlingRateLimit = 50,
                ThrottlingBurstLimit = 100,
            },
        });
        foreach (var r in routes) stage.AddResourceDependency(r);

        ApiDomain = $"{api.Ref}.execute-api.{Aws.REGION}.{Aws.URL_SUFFIX}";

        _ = new CfnOutput(this, "ApiUrl", new CfnOutputProps { Value = $"https://{ApiDomain}" });
    }
}
