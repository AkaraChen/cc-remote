import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ConnectionSettings } from "./client/connection-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "connection",
    title: "cc-remote",
    icon: "Server",
    Component: ConnectionSettings,
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: "cc-remote: connection settings",
    icon: "Server",
    keywords: ["claude", "remote", "ssh", "host"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("connection");
    },
  });
  return () => {};
}
