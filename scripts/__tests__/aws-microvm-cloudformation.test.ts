import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AWS Lambda MicroVM network prerequisites", () => {
  const template = readFileSync(
    join(process.cwd(), "aws-lambda-microvm/cloudformation.yaml"),
    "utf8",
  );

  it("routes regional S3 traffic through a free gateway endpoint", () => {
    expect(template).toMatch(
      /EgressS3GatewayEndpoint:\s+Type: AWS::EC2::VPCEndpoint/,
    );
    expect(template).toMatch(
      /ServiceName: !Sub "com\.amazonaws\.\$\{AWS::Region\}\.s3"/,
    );
    expect(template).toMatch(/VpcEndpointType: Gateway/);
    expect(template).toMatch(/RouteTableIds:\s+- !Ref EgressPrivateRouteTable/);
  });
});
