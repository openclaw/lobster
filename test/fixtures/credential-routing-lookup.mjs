// Test-only name resolution; transport and certificate checks remain native.
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const lookup = dns.lookup;
dns.lookup = (hostname, ...args) =>
	lookup(hostname === "gateway.test" ? "127.0.0.1" : hostname, ...args);
syncBuiltinESMExports();
