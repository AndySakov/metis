import http from "node:http";
import { app } from "./app.js";
import dotenv from "dotenv";

dotenv.config();
const port = Number(process.env.PORT ?? 8080);
const server = http.createServer(app);
server.listen(port, () =>
  console.log(`METIS dev server listening on :${port}`)
);

export { server };
