<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';

const props = defineProps<{
  host: string;
  port: number;
  initialPath?: string;
}>();

const emit = defineEmits<{
  select: [path: string];
  cancel: [];
}>();

interface DirEntry {
  name: string;
  isDir: boolean;
}

const currentPath = ref('');
const entries = ref<DirEntry[]>([]);
const loading = ref(false);
const errorMsg = ref<string | null>(null);

const parentPath = computed(() => {
  if (!currentPath.value || currentPath.value === '/') return null;
  const parts = currentPath.value.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.length === 1 ? '/' : parts.join('/');
});

async function fetchEntries(dirPath?: string) {
  loading.value = true;
  errorMsg.value = null;
  try {
    const url = new URL(`http://${props.host}:${props.port}/api/ls`);
    if (dirPath) {
      url.searchParams.set('path', dirPath);
    }
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (!resp.ok) {
      errorMsg.value = data.error || `HTTP ${resp.status}`;
      return;
    }
    currentPath.value = data.path;
    entries.value = data.entries;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function navigateTo(dirName: string) {
  const target = currentPath.value.endsWith('/')
    ? currentPath.value + dirName
    : currentPath.value + '/' + dirName;
  fetchEntries(target);
}

function navigateUp() {
  if (parentPath.value !== null) {
    fetchEntries(parentPath.value);
  }
}

function handleSelect() {
  emit('select', currentPath.value);
}

function handleCancel() {
  emit('cancel');
}

onMounted(() => {
  fetchEntries(props.initialPath || undefined);
});
</script>

<template>
  <div class="remote-picker-overlay" @click.self="handleCancel">
    <div class="remote-picker-dialog">
      <div class="dialog-header">
        <h3>Select Remote Directory</h3>
      </div>

      <div class="current-path" :title="currentPath">
        {{ currentPath || '...' }}
      </div>

      <div class="dialog-content">
        <div v-if="loading" class="loading-state">Loading...</div>

        <div v-else-if="errorMsg" class="error-state">
          <span class="error-icon">&#9888;</span>
          <span>{{ errorMsg }}</span>
          <button class="retry-btn" @click="fetchEntries(currentPath || undefined)">Retry</button>
        </div>

        <div v-else class="entry-list">
          <div
            v-if="parentPath !== null"
            class="entry-item parent-entry"
            @click="navigateUp"
          >
            <span class="entry-icon">&larr;</span>
            <span class="entry-name">..</span>
          </div>
          <div
            v-for="entry in entries"
            :key="entry.name"
            class="entry-item"
            @click="navigateTo(entry.name)"
          >
            <span class="entry-icon">&#128193;</span>
            <span class="entry-name">{{ entry.name }}</span>
          </div>
          <div v-if="entries.length === 0 && parentPath === null" class="empty-state">
            No subdirectories found
          </div>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="select-btn" @click="handleSelect" :disabled="!currentPath">
          Select
        </button>
        <button class="cancel-btn" @click="handleCancel">
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-picker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.remote-picker-dialog {
  background: var(--bg-dialog, #fff);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  max-width: 520px;
  width: 90%;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  background: var(--bg-header, #f5f5f5);
  border-bottom: 1px solid var(--border-color, #e0e0e0);
}

.dialog-header h3 {
  margin: 0;
  font-size: 1.1rem;
}

.current-path {
  padding: 0.5rem 1rem;
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--text-secondary, #666);
  background: var(--bg-hover, #f0f0f0);
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dialog-content {
  flex: 1;
  overflow-y: auto;
  min-height: 200px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  color: var(--text-muted, #999);
}

.error-state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  color: #c00;
  background: #fee;
}

.error-icon {
  flex-shrink: 0;
}

.retry-btn {
  margin-left: auto;
  padding: 0.25rem 0.75rem;
  border: 1px solid #c00;
  border-radius: 4px;
  background: transparent;
  color: #c00;
  cursor: pointer;
  font-size: 0.8rem;
}

.retry-btn:hover {
  background: #fdd;
}

.entry-list {
  padding: 0.25rem 0;
}

.entry-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--text-primary, #333);
}

.entry-item:hover {
  background: var(--bg-hover, #f0f0f0);
}

.parent-entry {
  color: var(--text-accent, #0066cc);
  font-weight: 500;
}

.entry-icon {
  flex-shrink: 0;
  width: 1.25rem;
  text-align: center;
}

.entry-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--text-muted, #999);
  font-size: 0.875rem;
}

.dialog-actions {
  display: flex;
  gap: 0.5rem;
  padding: 1rem;
  border-top: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-footer, #fafafa);
}

.select-btn {
  flex: 1;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 4px;
  background: var(--bg-primary, #0066cc);
  color: white;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.select-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover, #0052a3);
}

.select-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel-btn {
  flex: 1;
  padding: 0.625rem 1rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--bg-button, #fff);
  font-size: 0.9rem;
  cursor: pointer;
}

.cancel-btn:hover {
  background: var(--bg-hover, #f0f0f0);
}
</style>
