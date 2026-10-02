using Amazon.CDK;
using Amazon.CDK.AWS.CloudFront;
using Amazon.CDK.AWS.CloudFront.Origins;
using Amazon.CDK.AWS.S3;
using Amazon.CDK.AWS.S3.Deployment;
using Constructs;

namespace SuperTickets.Cdk;

public class WebStackProps : StackProps
{
    /// <summary>API Gateway domain without scheme, e.g. abc123.execute-api.eu-west-1.amazonaws.com.</summary>
    public required string ApiOriginDomain { get; init; }
}

/// <summary>SPA in S3 behind CloudFront (OAC); API paths forwarded to API Gateway (aws-publish.md).</summary>
public class WebStack : Stack
{
    private static readonly string[] ApiPaths = ["/events*", "/orders*", "/admin/*"];

    public WebStack(Construct scope, string id, WebStackProps props) : base(scope, id, props)
    {
        var bucket = new Bucket(this, "SpaBucket", new BucketProps
        {
            BlockPublicAccess = BlockPublicAccess.BLOCK_ALL,
            Encryption = BucketEncryption.S3_MANAGED,
            EnforceSSL = true,
            RemovalPolicy = RemovalPolicy.DESTROY,
            AutoDeleteObjects = true,
        });

        // Rewrite SPA routes (no file extension) to /index.html. No error-page rules: they would hide API 404s.
        var spaRewrite = new Function(this, "SpaRewrite", new FunctionProps
        {
            Runtime = FunctionRuntime.JS_2_0,
            Code = FunctionCode.FromInline(
                "function handler(event) {\n" +
                "  var request = event.request;\n" +
                "  if (request.uri.indexOf('.') === -1) { request.uri = '/index.html'; }\n" +
                "  return request;\n" +
                "}"),
        });

        var apiOrigin = new HttpOrigin(props.ApiOriginDomain, new HttpOriginProps
        {
            ProtocolPolicy = OriginProtocolPolicy.HTTPS_ONLY,
        });

        var apiBehavior = new BehaviorOptions
        {
            Origin = apiOrigin,
            ViewerProtocolPolicy = ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            AllowedMethods = AllowedMethods.ALLOW_ALL,
            CachePolicy = CachePolicy.CACHING_DISABLED,
            OriginRequestPolicy = OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        };

        var distribution = new Distribution(this, "Distribution", new DistributionProps
        {
            DefaultRootObject = "index.html",
            DefaultBehavior = new BehaviorOptions
            {
                Origin = S3BucketOrigin.WithOriginAccessControl(bucket),
                ViewerProtocolPolicy = ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                FunctionAssociations =
                [
                    new FunctionAssociation { Function = spaRewrite, EventType = FunctionEventType.VIEWER_REQUEST },
                ],
            },
            AdditionalBehaviors = ApiPaths.ToDictionary(p => p, _ => (IBehaviorOptions)apiBehavior),
        });

        _ = new BucketDeployment(this, "SpaDeployment", new BucketDeploymentProps
        {
            Sources = [Source.Asset("../../src/web/dist")],
            DestinationBucket = bucket,
            Distribution = distribution,
            DistributionPaths = ["/*"],
        });

        _ = new CfnOutput(this, "CloudFrontUrl", new CfnOutputProps { Value = $"https://{distribution.DistributionDomainName}" });
    }
}
