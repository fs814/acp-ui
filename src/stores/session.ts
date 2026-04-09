// Session store for managing ACP sessions with multi-tab support
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { load, Store } from '@tauri-apps/plugin-store';
import { getVersion } from '@tauri-apps/api/app';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { trackEvent, trackError } from '../lib/telemetry';
import type { SavedSession, ChatMessage, ToolCallInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo } from '../lib/types';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { spawnAgent, connectRemoteAgent, killAgent, onAgentStderr } from '../lib/tauri';
import { useConfigStore } from './config';
import type { SessionNotification, AuthMethod } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';
const PROTOCOL_VERSION = 1;

let appVersion = '0.1.0';

function detectPhase(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes('download') || lower.includes('fetch') || lower.includes('get ')) {
    return 'downloading';
  }
  if (lower.includes('install') || lower.includes('added') || lower.includes('packages')) {
    return 'installing';
  }
  if (lower.includes('build') || lower.includes('compil')) {
    return 'building';
  }
  if (lower.includes('start') || lower.includes('spawn')) {
    return 'starting';
  }
  return null;
}

export interface TabSession {
  id: string;
  label: string;
  type: 'chat' | 'webview';
  url: string | null;
  session: SavedSession | null;
  messages: ChatMessage[];
  toolCalls: Map<string, ToolCallInfo>;
  isConnected: boolean;
  isLoading: boolean;
  isConnecting: boolean;
  connectionAborted: boolean;
  pendingPermission: PermissionRequest | null;
  pendingAuthMethods: AuthMethod[];
  pendingAuthAgentName: string;
  availableModes: SessionMode[];
  currentModeId: string;
  availableCommands: SlashCommand[];
  availableModels: ModelInfo[];
  currentModelId: string;
  startupPhase: string;
  startupLogs: string[];
  startupElapsed: number;
  error: string | null;
}

function createTabSession(id: string, label: string): TabSession {
  return {
    id,
    label,
    type: 'chat',
    url: null,
    session: null,
    messages: [],
    toolCalls: new Map(),
    isConnected: false,
    isLoading: false,
    isConnecting: false,
    connectionAborted: false,
    pendingPermission: null,
    pendingAuthMethods: [],
    pendingAuthAgentName: '',
    availableModes: [],
    currentModeId: '',
    availableCommands: [],
    availableModels: [],
    currentModelId: '',
    startupPhase: 'starting',
    startupLogs: [],
    startupElapsed: 0,
    error: null,
  };
}

// Non-reactive side tables for objects incompatible with Vue's proxy system
const tabClients = new Map<string, AcpClientBridge>();
const tabAuthResolvers = new Map<string, (methodId: string | null) => void>();
const tabTimers = new Map<string, ReturnType<typeof setInterval>>();
const tabStderrUnlisteners = new Map<string, () => void>();
let webviewCounter = 0;

export const useSessionStore = defineStore('session', () => {
  const savedSessions = ref<SavedSession[]>([]);
  let store: Store | null = null;

  // Multi-tab state: plain array, mutate via full reassignment for reliable reactivity
  const tabList = ref<TabSession[]>([]);
  const activeTabId = ref<string | null>(null);

  function findTab(tabId: string): TabSession | undefined {
    return tabList.value.find(t => t.id === tabId);
  }

  // Add a tab and return the reactive proxy version from the array
  function addTab(plainTab: TabSession): TabSession {
    tabList.value = [...tabList.value, plainTab];
    return findTab(plainTab.id)!;
  }

  const activeTab = computed<TabSession | null>(() =>
    activeTabId.value ? findTab(activeTabId.value) ?? null : null
  );

  // Compatibility layer — same names as before, delegates to active tab
  const currentSession = computed(() => activeTab.value?.session ?? null);
  const messages = computed(() => activeTab.value?.messages ?? []);
  const isConnected = computed(() => activeTab.value?.isConnected ?? false);
  const isLoading = computed(() => activeTab.value?.isLoading ?? false);
  const isConnecting = computed(() => activeTab.value?.isConnecting ?? false);
  const error = computed(() => activeTab.value?.error ?? null);
  const pendingPermission = computed(() => activeTab.value?.pendingPermission ?? null);
  const pendingAuthMethods = computed(() => activeTab.value?.pendingAuthMethods ?? []);
  const pendingAuthAgentName = computed(() => activeTab.value?.pendingAuthAgentName ?? '');
  const availableModes = computed(() => activeTab.value?.availableModes ?? []);
  const currentModeId = computed(() => activeTab.value?.currentModeId ?? '');
  const availableCommands = computed(() => activeTab.value?.availableCommands ?? []);
  const availableModels = computed(() => activeTab.value?.availableModels ?? []);
  const currentModelId = computed(() => activeTab.value?.currentModelId ?? '');
  const startupPhase = computed(() => activeTab.value?.startupPhase ?? 'starting');
  const startupLogs = computed(() => activeTab.value?.startupLogs ?? []);
  const startupElapsed = computed(() => activeTab.value?.startupElapsed ?? 0);

  const hasActiveSession = computed(() => currentSession.value !== null);
  const messageList = computed(() => messages.value);
  const toolCallList = computed(() => {
    const tab = activeTab.value;
    return tab ? Array.from(tab.toolCalls.values()) : [];
  });
  const resumableSessions = computed(() =>
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );

  function getClient(tabId: string): AcpClientBridge | null {
    return tabClients.get(tabId) ?? null;
  }

  async function initStore() {
    store = await load(STORE_PATH);
    const saved = await store.get<SavedSession[]>('sessions');
    if (saved) {
      savedSessions.value = saved;
    }
    try {
      appVersion = await getVersion();
    } catch (e) {
      console.warn('Failed to get app version:', e);
    }
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      await store.save();
    }
  }

  function handleSessionUpdate(tabId: string, notification: SessionNotification) {
    const tab = findTab(tabId);
    if (!tab) return;

    const update = notification.update;

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const lastUserMsg = tab.messages[tab.messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          if (update.content.type === 'text') {
            lastUserMsg.content += update.content.text;
          }
        } else {
          tab.messages.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'agent_message_chunk': {
        const lastMsg = tab.messages[tab.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastMsg.content += update.content.text;
          }
        } else {
          tab.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;
      }

      case 'agent_thought_chunk': {
        const lastAssistantMsg = tab.messages[tab.messages.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          tab.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            thought: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;
      }

      case 'tool_call': {
        const currentAssistantMsg = tab.messages[tab.messages.length - 1];
        if (currentAssistantMsg && currentAssistantMsg.role === 'assistant') {
          if (!currentAssistantMsg.toolCalls) {
            currentAssistantMsg.toolCalls = [];
          }
          currentAssistantMsg.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations,
          });
        }
        tab.toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        });
        break;
      }

      case 'tool_call_update': {
        const existing = tab.toolCalls.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          for (const msg of tab.messages) {
            if (msg.toolCalls) {
              const tc = msg.toolCalls.find(t => t.toolCallId === update.toolCallId);
              if (tc) {
                if (update.status) tc.status = update.status;
                if (update.title) tc.title = update.title;
              }
            }
          }
        }
        break;
      }

      case 'current_mode_update':
        if ('modeId' in update && update.modeId) {
          tab.currentModeId = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          tab.availableCommands = update.availableCommands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            hint: cmd.input?.hint ?? undefined,
          }));
        }
        break;

      default:
        console.log('Unhandled session update:', update);
    }
  }

  async function promptForAuthMethod(tabId: string, authMethods: AuthMethod[], agentName: string): Promise<string | null> {
    const tab = findTab(tabId);
    if (!tab) return null;

    return new Promise((resolve) => {
      tab.pendingAuthMethods = authMethods;
      tab.pendingAuthAgentName = agentName;
      tabAuthResolvers.set(tabId, resolve);
    });
  }

  function selectAuthMethod(methodId: string): void {
    const tabId = activeTabId.value;
    if (!tabId) return;
    const tab = findTab(tabId);
    const resolver = tabAuthResolvers.get(tabId);
    if (tab && resolver) {
      resolver(methodId);
      tabAuthResolvers.delete(tabId);
      tab.pendingAuthMethods = [];
      tab.pendingAuthAgentName = '';
    }
  }

  function cancelAuthSelection(): void {
    const tabId = activeTabId.value;
    if (!tabId) return;
    const tab = findTab(tabId);
    const resolver = tabAuthResolvers.get(tabId);
    if (tab && resolver) {
      resolver(null);
      tabAuthResolvers.delete(tabId);
      tab.pendingAuthMethods = [];
      tab.pendingAuthAgentName = '';
    }
  }

  function cleanupTab(tabId: string) {
    const timer = tabTimers.get(tabId);
    if (timer) {
      clearInterval(timer);
      tabTimers.delete(tabId);
    }
    const unlisten = tabStderrUnlisteners.get(tabId);
    if (unlisten) {
      unlisten();
      tabStderrUnlisteners.delete(tabId);
    }
    tabAuthResolvers.delete(tabId);
  }

  function removeTab(tabId: string) {
    cleanupTab(tabId);
    tabClients.delete(tabId);
    tabList.value = tabList.value.filter(t => t.id !== tabId);
    if (activeTabId.value === tabId) {
      const len = tabList.value.length;
      activeTabId.value = len > 0 ? tabList.value[len - 1].id : null;
    }
  }

  async function createSession(agentName: string, cwd: string): Promise<void> {
    const tabId = crypto.randomUUID();
    const plainTab = createTabSession(tabId, agentName);

    // Full array reassignment triggers Vue reactivity; get the reactive proxy back
    const tab = addTab(plainTab);

    // Keep showing the current tab if it's connected; switch once the new one is ready
    const previousTabId = activeTabId.value;
    const hasExistingConnected = previousTabId && findTab(previousTabId)?.isConnected;
    if (!hasExistingConnected) {
      activeTabId.value = tabId;
    }

    tab.isLoading = true;
    tab.isConnecting = true;
    tab.connectionAborted = false;
    tab.error = null;

    tab.startupPhase = 'starting';
    tab.startupLogs = [];
    tab.startupElapsed = 0;
    tabTimers.set(tabId, setInterval(() => { tab.startupElapsed++; }, 1000));

    try {
      const configStore = useConfigStore();
      const agentConfig = configStore.config.agents[agentName];
      const agentInstance = agentConfig?.connection_type === 'remote'
        ? await connectRemoteAgent(agentName)
        : await spawnAgent(agentName);

      const stderrUnlisten = await onAgentStderr((stderr) => {
        if (stderr.agent_id === agentInstance.id) {
          tab.startupLogs.push(stderr.line);
          const detectedPhase = detectPhase(stderr.line);
          if (detectedPhase) {
            tab.startupPhase = detectedPhase;
          }
        }
      }) as unknown as () => void;
      tabStderrUnlisteners.set(tabId, stderrUnlisten);

      if (tab.connectionAborted) {
        await killAgent(agentInstance.id);
        throw new Error('Connection cancelled');
      }

      tab.startupPhase = 'initializing';

      const client = await createAcpClient(agentInstance);
      tabClients.set(tabId, client);
      client.onSessionUpdate = (n: SessionNotification) => handleSessionUpdate(tabId, n);

      watch(
        () => client.pendingPermissionRequest.value,
        (newValue) => { tab.pendingPermission = newValue ?? null; },
        { immediate: true }
      );

      if (tab.connectionAborted) {
        await client.disconnect();
        throw new Error('Connection cancelled');
      }

      tab.startupPhase = 'connecting';

      const initResponse = await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: { name: 'acp-ui', title: 'ACP UI', version: appVersion },
      });

      console.log('Agent initialized:', initResponse);
      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;

      if (tab.connectionAborted) {
        await client.disconnect();
        throw new Error('Connection cancelled');
      }

      const availableAuthMethods = initResponse.authMethods || [];

      if (tab.connectionAborted) {
        await client.disconnect();
        throw new Error('Connection cancelled');
      }

      let sessionResponse;
      try {
        sessionResponse = await client.newSession({ cwd, mcpServers: [] });
      } catch (sessionError: unknown) {
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');

        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          const selectedMethodId = await promptForAuthMethod(tabId, availableAuthMethods, agentName);

          if (!selectedMethodId || tab.connectionAborted) {
            await client.disconnect();
            throw new Error('Authentication cancelled by user');
          }

          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await client.authenticate({ methodId: selectedMethodId });
          console.log('Authentication successful:', authResponse);

          if (tab.connectionAborted) {
            await client.disconnect();
            throw new Error('Connection cancelled');
          }

          sessionResponse = await client.newSession({ cwd, mcpServers: [] });
        } else {
          throw sessionError;
        }
      }

      const session: SavedSession = {
        id: crypto.randomUUID(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: `Session ${new Date().toLocaleString()}`,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      tab.session = session;
      savedSessions.value.push(session);
      await saveSessionsToStore();

      tab.isConnected = true;
      tab.messages = [];
      tab.toolCalls.clear();

      // Connection succeeded — switch to the new tab
      activeTabId.value = tabId;

      trackEvent('SessionCreated', { agentName, success: 'true' });

      if (sessionResponse.modes) {
        tab.availableModes = (sessionResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        tab.currentModeId = sessionResponse.modes.currentModeId || '';
      } else {
        tab.availableModes = [];
        tab.currentModeId = '';
      }

      if (sessionResponse.models) {
        tab.availableModels = (sessionResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        tab.currentModelId = sessionResponse.models.currentModelId || '';
      } else {
        tab.availableModels = [];
        tab.currentModelId = '';
      }

    } catch (e) {
      removeTab(tabId);
      trackEvent('SessionCreated', { agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      tab.isLoading = false;
      tab.isConnecting = false;
      cleanupTab(tabId);
    }
  }

  async function resumeSession(savedSession: SavedSession): Promise<void> {
    // Deduplicate: if session is already open, switch to it
    for (const tab of tabList.value) {
      if (tab.session?.sessionId === savedSession.sessionId) {
        activeTabId.value = tab.id;
        return;
      }
    }

    const tabId = crypto.randomUUID();
    const plainTab = createTabSession(tabId, savedSession.agentName);
    const tab = addTab(plainTab);

    const previousTabId = activeTabId.value;
    const hasExistingConnected = previousTabId && findTab(previousTabId)?.isConnected;
    if (!hasExistingConnected) {
      activeTabId.value = tabId;
    }

    tab.isLoading = true;
    tab.error = null;

    try {
      const configStore = useConfigStore();
      const agentConfig = configStore.config.agents[savedSession.agentName];
      const agentInstance = agentConfig?.connection_type === 'remote'
        ? await connectRemoteAgent(savedSession.agentName)
        : await spawnAgent(savedSession.agentName);

      const client = await createAcpClient(agentInstance);
      tabClients.set(tabId, client);
      client.onSessionUpdate = (n: SessionNotification) => handleSessionUpdate(tabId, n);

      watch(
        () => client.pendingPermissionRequest.value,
        (newValue) => { tab.pendingPermission = newValue ?? null; },
        { immediate: true }
      );

      const initResponse = await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: { name: 'acp-ui', title: 'ACP UI', version: appVersion },
      });

      const availableAuthMethods = initResponse.authMethods || [];

      tab.messages = [];
      tab.toolCalls.clear();

      try {
        await client.loadSession({
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');

        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          const selectedMethodId = await promptForAuthMethod(tabId, availableAuthMethods, savedSession.agentName);

          if (!selectedMethodId) {
            await client.disconnect();
            throw new Error('Authentication cancelled by user');
          }

          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await client.authenticate({ methodId: selectedMethodId });
          console.log('Authentication successful:', authResponse);

          await client.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      tab.session = savedSession;
      tab.isConnected = true;

      // Connection succeeded — switch to the new tab
      activeTabId.value = tabId;

      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'true' });

      savedSession.lastUpdated = Date.now();
      await saveSessionsToStore();

    } catch (e) {
      removeTab(tabId);
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      tab.isLoading = false;
    }
  }

  async function sendPrompt(text: string): Promise<void> {
    const tab = activeTab.value;
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (!tab || !client || !tab.session) {
      throw new Error('No active session');
    }

    tab.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    tab.isLoading = true;
    try {
      const response = await client.prompt({
        sessionId: tab.session.sessionId,
        prompt: [{ type: 'text', text }],
      });

      console.log('Prompt completed:', response.stopReason);

      trackEvent('PromptSent', {
        messageLength: String(text.length),
        stopReason: response.stopReason || 'unknown',
      });

      if (tab.messages.length === 2 && tab.session) {
        tab.session.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        tab.session.lastUpdated = Date.now();
        await saveSessionsToStore();
      }
    } finally {
      tab.isLoading = false;
    }
  }

  async function cancelOperation(): Promise<void> {
    const tab = activeTab.value;
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (!tab || !client || !tab.session) return;

    await client.cancel({ sessionId: tab.session.sessionId });
  }

  async function cancelConnection(): Promise<void> {
    const tab = activeTab.value;
    const tabId = activeTabId.value;
    if (!tab || !tabId) return;

    tab.connectionAborted = true;

    const resolver = tabAuthResolvers.get(tabId);
    if (resolver) {
      resolver(null);
      tabAuthResolvers.delete(tabId);
      tab.pendingAuthMethods = [];
      tab.pendingAuthAgentName = '';
    }

    const client = getClient(tabId);
    if (client) {
      try {
        await client.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
    }

    removeTab(tabId);
  }

  function resolvePermission(optionId: string): void {
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (client) {
      client.resolvePermission(optionId);
    }
  }

  function cancelPermission(): void {
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (client) {
      client.cancelPermission();
    }
  }

  async function closeTab(tabId?: string): Promise<void> {
    const id = tabId ?? activeTabId.value;
    if (!id) return;

    const tab = findTab(id);
    if (!tab) return;

    const agentName = tab.session?.agentName || 'unknown';
    const sessionStart = tab.session?.lastUpdated || Date.now();
    const sessionDuration = Math.round((Date.now() - sessionStart) / 1000);

    const client = getClient(id);
    if (client) {
      try {
        await client.disconnect();
      } catch (e) {
        console.error('Error disconnecting tab:', e);
      }
    }

    trackEvent('SessionDisconnected', {
      agentName,
      sessionDurationSeconds: String(sessionDuration),
      messageCount: String(tab.messages.length),
    });

    removeTab(id);
  }

  async function disconnect(): Promise<void> {
    await closeTab();
  }

  function switchTab(tabId: string): void {
    if (findTab(tabId)) {
      activeTabId.value = tabId;
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
  }

  async function setMode(modeId: string): Promise<void> {
    const tab = activeTab.value;
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (!tab || !client || !tab.session) {
      throw new Error('No active session');
    }

    await client.setMode({ sessionId: tab.session.sessionId, modeId });
    tab.currentModeId = modeId;
  }

  async function setModel(modelId: string): Promise<void> {
    const tab = activeTab.value;
    const tabId = activeTabId.value;
    const client = tabId ? getClient(tabId) : null;
    if (!tab || !client || !tab.session) {
      throw new Error('No active session');
    }

    await client.unstable_setSessionModel({ sessionId: tab.session.sessionId, modelId });
    tab.currentModelId = modelId;
  }

  function clearError() {
    const tab = activeTab.value;
    if (tab) {
      tab.error = null;
    }
  }

  function openWebviewTab(url: string): void {
    let label: string;
    try {
      label = new URL(url).hostname;
    } catch {
      label = url.slice(0, 30);
    }

    const windowLabel = `webview-${++webviewCounter}`;
    const wvw = new WebviewWindow(windowLabel, {
      url,
      title: label,
      width: 1024,
      height: 768,
      center: true,
    });

    wvw.once('tauri://error', (e) => {
      console.error('Webview window error:', e);
    });
  }

  return {
    // Persistent state
    savedSessions,

    // Multi-tab state
    tabList,
    activeTabId,
    activeTab,

    // Compatibility layer (delegates to active tab)
    currentSession,
    messages,
    isConnected,
    isLoading,
    isConnecting,
    error,
    pendingPermission,
    pendingAuthMethods,
    pendingAuthAgentName,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    startupPhase,
    startupLogs,
    startupElapsed,

    // Computed
    hasActiveSession,
    messageList,
    toolCallList,
    resumableSessions,

    // Actions
    initStore,
    createSession,
    resumeSession,
    sendPrompt,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    selectAuthMethod,
    cancelAuthSelection,
    disconnect,
    closeTab,
    switchTab,
    deleteSession,
    setMode,
    setModel,
    clearError,
    openWebviewTab,

    // Expose client for permission handling (via non-reactive side table)
    get acpClient() {
      const tabId = activeTabId.value;
      return tabId ? getClient(tabId) : null;
    },
  };
});
