using Amazon.CDK;
using SuperTickets.Cdk;

var app = new App();

var data = new DataStack(app, "SuperTickets-Data");
var messaging = new MessagingStack(app, "SuperTickets-Messaging");

var services = new ServicesStack(app, "SuperTickets-Services", new ServicesStackProps { Data = data, Messaging = messaging });

var api = new ApiStack(app, "SuperTickets-Api", new ApiStackProps { Data = data, Services = services });

_ = new WebStack(app, "SuperTickets-Web", new WebStackProps { ApiOriginDomain = api.ApiDomain });

app.Synth();
