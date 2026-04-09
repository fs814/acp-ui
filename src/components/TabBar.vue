<script setup lang="ts">
import { useSessionStore } from '../stores/session';

const sessionStore = useSessionStore();
</script>

<template>
  <div class="tab-bar" v-if="sessionStore.tabList.length > 0">
    <div class="tab-list">
      <div
        v-for="tab in sessionStore.tabList"
        :key="tab.id"
        class="tab-item"
        :class="{ active: sessionStore.activeTabId === tab.id }"
        @click="sessionStore.switchTab(tab.id)"
      >
        <span
          class="status-dot"
          :class="{
            connected: tab.isConnected,
            connecting: tab.isConnecting,
            disconnected: !tab.isConnected && !tab.isConnecting,
          }"
        ></span>
        <span class="tab-label">{{ tab.label }}</span>
        <span
          class="tab-close"
          role="button"
          tabindex="0"
          @click.stop="sessionStore.closeTab(tab.id)"
          @keydown.enter.stop="sessionStore.closeTab(tab.id)"
          title="Close tab"
        >&times;</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  height: 36px;
  min-height: 36px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  overflow-y: hidden;
}

.tab-list {
  display: flex;
  height: 100%;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 100%;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: border-color 0.15s, color 0.15s;
}

.tab-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tab-item.active {
  border-bottom-color: var(--bg-primary);
  color: var(--text-primary);
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.connected {
  background: #28a745;
}

.status-dot.connecting {
  background: #ffc107;
  animation: pulse 1s ease-in-out infinite;
}

.status-dot.disconnected {
  background: #999;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.tab-label {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}

.tab-item:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: rgba(220, 53, 69, 0.15);
  color: var(--bg-danger);
}
</style>
