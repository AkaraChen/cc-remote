import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { doctor, requireHost, spawnAcp } from "./server/launch";
import { connectionSettings, doctorRpc } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(connectionSettings);

  server.registerProvider(
    runAcpProvider({
      id: "cc-remote",
      label: "Claude (remote)",
      description: "Claude Code on a remote host over ssh, with the tools on this machine",
      icon: "icon.svg",
      // Paseo starts one cc-remote per session, so reading the settings here means a saved
      // change applies to the next session without reloading the plugin.
      async connector() {
        const current = await settings.read();
        if (current.status !== "ready") {
          throw new Error(`cc-remote settings are invalid: ${current.error}`);
        }
        requireHost(current.values);
        return spawnAcp(current.values);
      },
      // ssh and the remote claude take longer to come up than a local agent.
      acpOptions: { startupTimeoutMs: 60_000 },
    }),
  );

  server.handle(doctorRpc, (connection) => doctor(connection));

  return () => {};
}
