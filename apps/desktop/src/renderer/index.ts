import type {
  ClientName,
  ConfigureClientsInput,
  DesktopSnapshot,
  ModelView,
  RelayEvent,
} from "../shared/contracts";

let state: DesktopSnapshot | null = null;
let selectedClients = new Set<ClientName>();

function element<T extends HTMLElement>(id: string) {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}

function input(id: string) {
  return element<HTMLInputElement>(id);
}

function button(id: string) {
  return element<HTMLButtonElement>(id);
}

function select(id: string) {
  return element<HTMLSelectElement>(id);
}

function text(id: string, value: unknown) {
  element(id).textContent = value === null || value === undefined
    ? "—"
    : String(value);
}

function notice(message: string, timeout = 5_000) {
  const target = element("notice");
  target.textContent = message;
  target.classList.remove("hidden");
  if (timeout > 0) {
    setTimeout(() => target.classList.add("hidden"), timeout);
  }
}

async function operation<T>(name: string, callback: () => Promise<T>) {
  document.body.setAttribute("aria-busy", "true");
  try {
    return await callback();
  } catch (error) {
    notice(`${name}: ${error instanceof Error ? error.message : String(error)}`, 0);
    throw error;
  } finally {
    document.body.removeAttribute("aria-busy");
  }
}

function statusClass(status: string) {
  if (status === "ready") {
    return "ready";
  }
  if (status.includes("fail") || status.startsWith("blocked")) {
    return "failed";
  }
  return "neutral";
}

function renderModels(models: ModelView[]) {
  const query = input("model-search").value.trim().toLowerCase();
  const filtered = models.filter((model) =>
    model.id.toLowerCase().includes(query)
    || (model.vendor ?? "").toLowerCase().includes(query));
  const list = element("models-list");
  list.replaceChildren();
  text("model-summary", `${filtered.length} of ${models.length} models`);

  for (const model of filtered) {
    const row = document.createElement("article");
    row.className = "model-row";

    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = model.id;
    const vendor = document.createElement("small");
    vendor.textContent = model.vendor ?? "Unknown vendor";
    identity.append(name, vendor);

    const chips = document.createElement("div");
    chips.className = "chips";
    const values = [
      ...model.endpoints,
      ...(model.streaming ? ["streaming"] : []),
      ...(model.toolCalls ? ["tools"] : []),
      ...(model.vision ? ["vision"] : []),
      ...model.reasoningEfforts.map((effort) => `reasoning:${effort}`),
    ];
    for (const value of values) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = value;
      chips.append(chip);
    }

    const probe = document.createElement("div");
    probe.className = "model-probe";
    const endpoint = document.createElement("select");
    endpoint.setAttribute("aria-label", `Endpoint for ${model.id}`);
    for (const value of model.endpoints.filter((item) =>
      ["/responses", "/messages", "ws:/responses"].includes(item))) {
      endpoint.add(new Option(value, value));
    }
    const effort = document.createElement("select");
    effort.setAttribute("aria-label", `Reasoning for ${model.id}`);
    effort.add(new Option("default", ""));
    for (const value of model.reasoningEfforts) {
      effort.add(new Option(value, value));
    }
    const test = document.createElement("button");
    test.textContent = "Test";
    test.disabled = endpoint.options.length === 0;
    test.addEventListener("click", () => {
      void operation("Model test failed", async () => {
        const result = await window.modelRelay.probeModel({
          modelId: model.id,
          endpoint: endpoint.value,
          ...(effort.value ? { reasoningEffort: effort.value } : {}),
        });
        notice(
          `${model.id}: ${result.ok ? "verified" : "failed"} · ${result.latencyMs} ms`
          + (result.returnedReasoning
            ? ` · reasoning ${result.returnedReasoning}`
            : ""),
          8_000,
        );
      });
    });
    probe.append(endpoint, effort, test);
    row.append(identity, chips, probe);
    list.append(row);
  }
}

function renderClients(snapshot: DesktopSnapshot) {
  const list = element("clients-list");
  list.replaceChildren();
  for (const client of snapshot.clients) {
    if (selectedClients.size === 0 && client.installed) {
      selectedClients.add(client.name);
    }
    const row = document.createElement("label");
    row.className = "client-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedClients.has(client.name);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedClients.add(client.name);
      } else {
        selectedClients.delete(client.name);
      }
    });
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = {
      claude: "Claude Code",
      codex: "Codex CLI",
      opencode: "OpenCode",
      pi: "Pi coding agent",
    }[client.name];
    const status = document.createElement("small");
    status.textContent = client.installed ? "Installed" : "Not detected";
    identity.append(name, status);
    const executable = document.createElement("small");
    executable.textContent = client.executable ?? "Configuration can still be generated.";
    row.append(checkbox, identity, executable);
    list.append(row);
  }
}

function render(snapshot: DesktopSnapshot) {
  state = snapshot;
  text("version", `Version ${snapshot.version}`);
  text("endpoint", snapshot.gateway.endpoint);
  text("model-count", snapshot.models.length);
  text(
    "client-count",
    snapshot.clients.filter((client) => client.installed).length,
  );
  text("active-release", snapshot.gateway.activeVersionId);
  const pill = element("status-pill");
  pill.textContent = snapshot.gateway.status;
  pill.className = `status-pill ${statusClass(snapshot.gateway.status)}`;
  button("start-gateway").disabled = snapshot.gateway.status === "ready";
  button("stop-gateway").disabled = snapshot.gateway.status !== "ready";

  text(
    "auth-description",
    snapshot.gateway.authenticated
      ? "Authenticated. GitHub controls token lifetime and may require sign-in again."
      : "Not authenticated. Sign in with the GitHub account that owns your Copilot subscription.",
  );
  button("authenticate").textContent = snapshot.gateway.authenticated
    ? "Sign in again"
    : "Sign in with GitHub";
  input("launch-at-login").checked = snapshot.settings.launchAtLogin;
  input("close-to-tray").checked = snapshot.settings.closeToTray;

  renderModels(snapshot.models);
  renderClients(snapshot);

  select("update-channel").value = snapshot.settings.updateChannel;
  text("update-state", snapshot.update.state);
  text("available-version", snapshot.update.availableVersion);
  text("update-message", snapshot.update.message ?? "");
  const progress = element<HTMLProgressElement>("update-progress");
  progress.value = snapshot.update.progress ?? 0;
  progress.classList.toggle("hidden", snapshot.update.progress === null);
  button("install-update").disabled = snapshot.update.state !== "downloaded";
  button("download-update").disabled = snapshot.update.state !== "available";

  text(
    "secure-storage",
    `${snapshot.secureStorage.backend} · ${snapshot.secureStorage.available ? "encrypted" : "unavailable"}`,
  );
  text("data-path", snapshot.paths.root);
  text("logs-path", snapshot.paths.logs);
  text("backups-path", snapshot.paths.backups);
}

function clientInput(
  dryRun: boolean,
  remove: boolean,
): ConfigureClientsInput {
  if (selectedClients.size === 0) {
    throw new Error("Select at least one client.");
  }
  return {
    clients: [...selectedClients],
    dryRun,
    remove,
    setDefault: input("set-client-defaults").checked,
  };
}

function showClientResult(value: unknown) {
  const output = element("client-output");
  output.textContent = JSON.stringify(value, null, 2);
  output.classList.remove("hidden");
}

function handleEvent(event: RelayEvent) {
  if (event.type === "snapshot") {
    render(event.snapshot);
    return;
  }
  if (event.type === "authentication") {
    const output = element("auth-output");
    output.classList.remove("hidden");
    output.textContent = `${output.textContent ?? ""}${event.message}\n`;
    button("cancel-auth").classList.toggle(
      "hidden",
      !["starting", "waiting"].includes(event.state),
    );
    if (event.state === "authenticated") {
      void window.modelRelay.snapshot().then(render);
    }
    return;
  }
  if (event.type === "update") {
    if (event.message) {
      notice(event.message, 8_000);
    }
    void window.modelRelay.snapshot().then(render);
  }
}

function bind() {
  for (const item of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    item.addEventListener("click", () => {
      const page = item.dataset.page;
      for (const nav of document.querySelectorAll(".nav-item")) {
        nav.classList.toggle("active", nav === item);
      }
      for (const content of document.querySelectorAll<HTMLElement>(".page")) {
        content.classList.toggle(
          "active",
          content.dataset.pageContent === page,
        );
      }
    });
  }
  button("start-gateway").addEventListener("click", () => void operation(
    "Unable to start gateway",
    async () => render(await window.modelRelay.gatewayAction("start")),
  ));
  button("stop-gateway").addEventListener("click", () => void operation(
    "Unable to stop gateway",
    async () => render(await window.modelRelay.gatewayAction("stop")),
  ));
  button("restart-gateway").addEventListener("click", () => void operation(
    "Unable to restart gateway",
    async () => render(await window.modelRelay.gatewayAction("restart")),
  ));
  button("authenticate").addEventListener("click", () => void operation(
    "Unable to start authentication",
    async () => {
      element("auth-output").textContent = "";
      element("auth-output").classList.remove("hidden");
      button("cancel-auth").classList.remove("hidden");
      await window.modelRelay.authenticate();
    },
  ));
  button("cancel-auth").addEventListener(
    "click",
    () => void window.modelRelay.cancelAuthentication(),
  );
  button("refresh-models").addEventListener("click", () => void operation(
    "Unable to refresh models",
    async () => render(await window.modelRelay.refreshModels()),
  ));
  input("model-search").addEventListener("input", () => {
    if (state !== null) {
      renderModels(state.models);
    }
  });
  input("launch-at-login").addEventListener("change", () => void operation(
    "Unable to update startup setting",
    async () => render(await window.modelRelay.updateSettings({
      launchAtLogin: input("launch-at-login").checked,
    })),
  ));
  input("close-to-tray").addEventListener("change", () => void operation(
    "Unable to update window setting",
    async () => render(await window.modelRelay.updateSettings({
      closeToTray: input("close-to-tray").checked,
    })),
  ));
  select("update-channel").addEventListener("change", () => void operation(
    "Unable to update channel",
    async () => render(await window.modelRelay.updateSettings({
      updateChannel: select("update-channel").value as "stable" | "beta",
    })),
  ));
  button("preview-clients").addEventListener("click", () => void operation(
    "Client preview failed",
    async () => showClientResult(
      await window.modelRelay.configureClients(clientInput(true, false)),
    ),
  ));
  button("configure-clients").addEventListener("click", () => void operation(
    "Client configuration failed",
    async () => showClientResult(
      await window.modelRelay.configureClients(clientInput(false, false)),
    ),
  ));
  button("restore-clients").addEventListener("click", () => void operation(
    "Client restore failed",
    async () => showClientResult(
      await window.modelRelay.configureClients(clientInput(false, true)),
    ),
  ));
  button("check-updates").addEventListener("click", () => void operation(
    "Update check failed",
    async () => render(await window.modelRelay.checkForUpdates()),
  ));
  button("download-update").addEventListener("click", () => void operation(
    "Update download failed",
    async () => window.modelRelay.downloadUpdate(),
  ));
  button("install-update").addEventListener(
    "click",
    () => void window.modelRelay.installUpdate(),
  );
}

bind();
window.modelRelay.onEvent(handleEvent);
void window.modelRelay.snapshot().then(render).catch((error) => {
  notice(error instanceof Error ? error.message : String(error), 0);
});
