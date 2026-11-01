import { type PluginSurfaceProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Platform, Text } from "react-native";
import { type Connection, connectionSchema, connectionSettings, doctorRpc } from "../shared/settings";

export function ConnectionSettings(props: PluginSurfaceProps) {
  const settings = useSettings(connectionSettings);
  const paseo = usePaseo();
  const muted = { color: props.theme.colors.foregroundMuted };

  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status === "error") return <Text style={muted}>{settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Connection">
        <SettingsCard>
          <SettingsAction
            label="The saved settings are invalid"
            hint={settings.error}
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  // Remount on save so the inputs start from what was stored.
  return (
    <Form
      key={settings.revision}
      {...props}
      saved={settings.values}
      saving={settings.saving}
      saveError={settings.saveError}
      save={async (values) => {
        const saved = await settings.save(values, settings.revision);
        // The provider list caches the last connection attempt; retry it with the new values.
        if (saved) void paseo.providers.refresh({ providers: ["cc-remote"] }).catch(() => undefined);
        return saved;
      }}
    />
  );
}

interface FormProps extends PluginSurfaceProps {
  saved: Connection;
  saving: boolean;
  saveError: string | null;
  save(values: Connection): Promise<boolean>;
}

function Form({ theme, saved, saving, saveError, save }: FormProps) {
  const [draft, setDraft] = useState(saved);
  const parsed = connectionSchema.safeParse(draft);
  const fieldError = (field: keyof Connection) =>
    parsed.success ? null : (parsed.error.issues.find((i) => i.path[0] === field)?.message ?? null);
  const dirty = (Object.keys(saved) as (keyof Connection)[]).some((k) => draft[k] !== saved[k]);

  const runDoctor = useRpc(doctorRpc);
  const doctor = useMutation({ mutationFn: runDoctor });

  const styles = useMemo(
    () => ({
      output: {
        color: theme.colors.foreground,
        fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
        fontSize: 12,
      },
      ok: { color: theme.colors.statusSuccess },
      failed: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  return (
    <>
      <SettingsSection title="Connection">
        <SettingsCard>
          <SettingsInput
            label="Host"
            hint="An ssh destination; ports, keys and jump hosts belong in ~/.ssh/config. Empty uses $CC_REMOTE_HOST or ~/.config/cc-remote/host."
            placeholder="devbox"
            initialValue={saved.host}
            error={fieldError("host")}
            onChangeText={(host) => setDraft((d) => ({ ...d, host }))}
          />
          <SettingsInput
            label="ssh command"
            hint="Sets CC_REMOTE_SSH. Empty uses plain ssh."
            placeholder="ssh -p 2222 -i ~/.ssh/devbox"
            initialValue={saved.sshCommand}
            error={fieldError("sshCommand")}
            onChangeText={(sshCommand) => setDraft((d) => ({ ...d, sshCommand }))}
          />
          <SettingsInput
            label="cc-remote executable"
            hint="Path to cc-remote on the daemon machine. ~/.local/bin is searched too."
            placeholder="cc-remote"
            initialValue={saved.command}
            error={fieldError("command")}
            onChangeText={(command) => setDraft((d) => ({ ...d, command }))}
          />
          <SettingsAction
            label="Save"
            hint="New sessions use the saved connection; open ones keep theirs."
            error={saveError}
            actionLabel={saving ? "Saving…" : "Save"}
            disabled={!dirty || !parsed.success || saving}
            onPress={() => parsed.success && void save(parsed.data)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Check">
        <SettingsCard>
          <SettingsAction
            label="Run cc-remote doctor"
            hint="Checks ssh and the remote claude version with the values above, saved or not."
            actionLabel={doctor.isPending ? "Checking…" : "Check"}
            disabled={!parsed.success || doctor.isPending}
            onPress={() => parsed.success && doctor.mutate(parsed.data)}
          />
          {doctor.data || doctor.error ? (
            <SettingsRow label={doctor.data?.ok ? "Connected" : "Failed"}>
              <Text style={doctor.data?.ok ? styles.ok : styles.failed}>
                {doctor.data?.ok ? "✓" : "✗"}
              </Text>
            </SettingsRow>
          ) : null}
          {doctor.data?.output || doctor.error ? (
            <SettingsRow label="Output">
              <Text selectable style={styles.output}>
                {doctor.data?.output ?? String(doctor.error)}
              </Text>
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
