import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform";
import { home } from "./tools/util";

/** The `oauth` field Claude Code accepts on an http or sse server. */
export type OAuthOptions = { clientId?: string; callbackPort?: number };

/** How long the callback waits for the user to finish in the browser. */
const WAIT = 10 * 60_000;

/** Where logins are kept, and how the user's browser opens. Replaceable, for tests. */
export const machine = {
  authDir: join(home, ".config", "cc-remote", "mcp-auth"),
  open(url: string) {
    const command = process.platform === "darwin" ? ["open", url] : WINDOWS ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
    try {
      Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }).unref();
    } catch {} // No browser here; the URL is in the tool result and on stderr.
  },
};

type Saved = { port?: number; client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

/** One login in progress: the page the user must visit, and the code it sends back. */
type Login = { url: URL; done: Promise<void> };

/**
 * OAuth for a remote MCP server that cc-remote reaches from this machine, as mcp-remote does it.
 * Claude Code would log in itself, but its callback listens on the host, where the browser isn't.
 * This registers a client, sends the user to the browser, takes the code on a localhost callback,
 * and keeps the tokens in ~/.config/cc-remote/mcp-auth/, one file per server URL.
 */
export class LocalOAuth implements OAuthClientProvider {
  private readonly file: string;
  private readonly port: number;
  private verifier = "";
  private expected = "";
  /** The authorization page from the last 401, for the next login. */
  private pending?: URL;
  private login?: Login;

  constructor(url: string, private readonly options: OAuthOptions = {}) {
    const hash = BigInt(Bun.hash(url));
    this.file = join(machine.authDir, `${hash.toString(36)}.json`);
    // The redirect URL is registered with the server, so it stays put: a port fixed per server.
    this.port = options.callbackPort ?? this.load().port ?? 20000 + Number(hash % 30000n);
  }

  private load(): Saved {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private save(update: Partial<Saved>) {
    mkdirSync(machine.authDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ ...this.load(), port: this.port, ...update }), { mode: 0o600 });
  }

  get redirectUrl() {
    return `http://localhost:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "cc-remote",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    return (this.expected = crypto.randomUUID());
  }

  clientInformation() {
    return this.options.clientId ? { client_id: this.options.clientId } : this.load().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ client });
  }

  // Read each time: another cc-remote may have refreshed them since.
  tokens() {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens });
  }

  redirectToAuthorization(url: URL) {
    this.pending = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") this.save({ client: undefined, tokens: undefined });
    if (scope === "tokens") this.save({ tokens: undefined });
  }

  /**
   * Sends the user to the authorization page the server asked for, and waits on the callback.
   * `exchange` trades the code for tokens. A login already under way is shared, not restarted.
   */
  authorize(exchange: (code: string) => Promise<void>): Login | undefined {
    if (this.login) return this.login;
    const url = this.pending;
    if (!url) return undefined;
    const done = this.callback().then(exchange);
    const login = (this.login = { url, done });
    done.catch(() => {}).finally(() => { if (this.login === login) this.login = undefined; });
    this.pending = undefined;
    machine.open(url.href);
    console.error(`cc-remote: to authorize the MCP server, open ${url.href}`);
    return login;
  }

  /** Listens on the redirect URL until the browser comes back with a code. */
  private callback(): Promise<string> {
    return new Promise((resolve, reject) => {
      const page = (status: number, text: string) =>
        new Response(`<!doctype html><title>cc-remote</title><p>${text}</p>`, { status, headers: { "content-type": "text/html" } });
      let server: ReturnType<typeof Bun.serve>;
      const finish = () => {
        clearTimeout(timer);
        setTimeout(() => server.stop(), 100);
      };
      const timer = setTimeout(() => {
        server.stop();
        reject(new Error("the authorization was not completed in time"));
      }, WAIT);
      try {
        server = Bun.serve({
          hostname: "localhost",
          port: this.port,
          fetch: (req) => {
            const query = new URL(req.url).searchParams;
            if (new URL(req.url).pathname !== "/callback") return page(404, "Not found.");
            if (query.get("state") !== this.expected) return page(400, "This authorization request is out of date. Start it again.");
            finish();
            const code = query.get("code");
            if (!code) {
              reject(new Error(query.get("error_description") ?? query.get("error") ?? "the server sent no authorization code"));
              return page(400, "Authorization failed. You can close this tab.");
            }
            resolve(code);
            return page(200, "Authorized. You can close this tab and go back to your agent.");
          },
        });
      } catch (e) {
        clearTimeout(timer);
        reject(new Error(`could not listen on ${this.redirectUrl}: ${(e as Error).message}`));
      }
    });
  }
}
