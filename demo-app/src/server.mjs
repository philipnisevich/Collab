// Zero-dependency HTTP API on node:http.
import http from "node:http";
import { getUser, listUsers, createUser } from "./users.mjs";

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/users\/([^/]+)$/);

  if (req.method === "GET" && url.pathname === "/users") return json(res, 200, listUsers());
  if (req.method === "GET" && match) {
    const user = getUser(match[1]);
    return user ? json(res, 200, user) : json(res, 404, { error: "not found" });
  }
  if (req.method === "POST" && url.pathname === "/users") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { name, email } = JSON.parse(body || "{}");
      if (!name || !email) return json(res, 400, { error: "name and email required" });
      return json(res, 201, createUser({ name, email }));
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
  }
  json(res, 404, { error: "no route" });
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`demo-app listening on :${server.address().port}`);
});
