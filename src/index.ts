import type { SDK } from "./sdk.generated.js";
import { fromEnv } from "@aws-sdk/credential-provider-env";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";

declare const fetch: typeof import("node-fetch").default;

interface SDKProps {
  endpoint?: string;
}

export const AWS: SDK = new Proxy({} as any, {
  get: (_, className: string) => {
    const region = process.env.AWS_REGION!;
    if (!region) {
      throw new Error(`Could not determine AWS_REGION`);
    }
    const service = className.toLowerCase();

    return class {
      constructor(options?: SDKProps) {
        const endpoint = options?.endpoint ?? resolveEndpoint(service, region);
        // TODO: support other types of credential providers
        const credentials = fromEnv();
        return new Proxy(
          {},
          {
            get: (_target, methodName: string) => {
              return async (input: any) => {
                const url = new URL(`https://${endpoint}`);

                // See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.LowLevelAPI.html

                const xAmzTarget = `${className}_${resolveVersion(
                  service
                ).replaceAll("-", "")}.${resolveAction(methodName)}`;

                const request = new HttpRequest({
                  hostname: url.hostname,
                  path: url.pathname,
                  protocol: url.protocol,
                  method: "POST",
                  body: JSON.stringify(input),
                  headers: {
                    // host is required by AWS Signature V4: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
                    host: url.host,
                    "Accept-Encoding": "identity",
                    "Content-Type": "application/x-amz-json-1.0",
                    "X-Amz-Target": xAmzTarget,
                  },
                });

                const signer = new SignatureV4({
                  credentials,
                  service,
                  region,
                  sha256: Sha256,
                });

                const signedRequest = await signer.sign(request);

                const response = await fetch(url.toString(), {
                  headers: signedRequest.headers,
                  body: signedRequest.body,
                  method: signedRequest.method,
                });

                if (response.status === 200) {
                  return response.json();
                } else {
                  // see: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html
                  // for now we'll just throw the error as a json object
                  // TODO: throw something that is easy to branch on and check instanceof - this may increase bundle size though
                  throw await response.json();
                }
              };
            },
          }
        );
      }
    };
  },
});

// see: https://docs.aws.amazon.com/general/latest/gr/ddb.html
function resolveEndpoint(serviceName: string, region: string) {
  // TODO: this doesn't work in all cases ...
  return `${serviceName.toLocaleLowerCase()}.${region}.amazonaws.com`;
}

// see: https://stackoverflow.com/questions/36490756/aws-rest-api-without-sdk
// see: https://docs.aws.amazon.com/general/latest/gr/create-signed-request.html#create-canonical-request
function resolveAction(methodName: string) {
  return `${methodName.charAt(0).toUpperCase()}${methodName.substring(1)}`;
}

// see: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html for an example of where this can be found
function resolveVersion(service: string) {
  if (service === "dynamodb") {
    return "2012-08-10";
  } else {
    throw new Error(`Unsupported service: ${service}`);
  }
}