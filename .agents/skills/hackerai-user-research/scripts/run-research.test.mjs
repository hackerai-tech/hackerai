import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import {
  createProxyDispatcher,
  gatewayRequest,
} from "./run-research.mjs";

let origin;
let proxy;
let originUrl;
let proxyUrl;
let proxyRequests = 0;

before(async () => {
  origin = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ authorization: request.headers.authorization }),
    );
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  originUrl = `http://127.0.0.1:${originAddress.port}/research`;

  proxy = createServer((request, response) => {
    proxyRequests += 1;
    const target = new URL(request.url);
    const forwarded = httpRequest(
      target,
      { method: request.method, headers: request.headers },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 500, upstream.headers);
        upstream.pipe(response);
      },
    );
    request.pipe(forwarded);
  });
  proxy.on("connect", (request, clientSocket, head) => {
    proxyRequests += 1;
    const [host, port] = request.url.split(":");
    const upstreamSocket = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
});

after(async () => {
  await Promise.all([
    new Promise((resolve, reject) =>
      origin.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
});

test("gateway requests use the configured HTTP proxy", async () => {
  const dispatcher = createProxyDispatcher({
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "",
  });

  try {
    const body = await gatewayRequest(originUrl, "synthetic-test-key", {}, {
      dispatcher,
    });

    assert.equal(proxyRequests, 1);
    assert.equal(body.authorization, "Bearer synthetic-test-key");
  } finally {
    await dispatcher.close();
  }
});

test("gateway requests do not create a dispatcher without proxy variables", () => {
  assert.equal(createProxyDispatcher({}), undefined);
});
