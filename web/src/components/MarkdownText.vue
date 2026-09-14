<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../composables/useMarkdown'

// Renders a Markdown string — currently Jira worklog comments, converted from
// ADF by the server. The HTML is sanitised in useMarkdown.js before it gets here.
const props = defineProps({
  text: { type: String, default: '' }
})

const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <!-- Safe: renderMarkdown() sanitises through DOMPurify. See useMarkdown.js. -->
  <div class="markdown" v-html="html" />
</template>

<style scoped>
/*
 * v-html content carries no scope attribute, so every rule below reaches it
 * through :deep(). The aim is prose that sits inside a dense card: the vertical
 * rhythm is tightened well below browser defaults and headings are scaled down
 * to near body size, since a worklog note is not a document.
 */
.markdown {
  word-break: break-word;
  overflow-wrap: anywhere;
}
.markdown :deep(> :first-child) {
  margin-top: 0;
}
.markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.markdown :deep(p) {
  margin: 0.35em 0;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  margin: 0.6em 0 0.25em;
  font-weight: 600;
  line-height: 1.3;
}
.markdown :deep(h1) { font-size: 1.15em; }
.markdown :deep(h2) { font-size: 1.1em; }
.markdown :deep(h3) { font-size: 1.05em; }
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) { font-size: 1em; }
.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0.35em 0;
  padding-left: 1.4em;
}
.markdown :deep(li) {
  margin: 0.15em 0;
}
.markdown :deep(li > p) {
  margin: 0;
}
.markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
}
.markdown :deep(code) {
  padding: 0.1em 0.35em;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.09);
  font-size: 0.9em;
}
.markdown :deep(pre) {
  margin: 0.4em 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.07);
  overflow-x: auto;
}
.markdown :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 0.85em;
}
.markdown :deep(blockquote) {
  margin: 0.4em 0;
  padding-left: 10px;
  border-left: 3px solid rgba(var(--v-border-color), 0.35);
  color: rgb(var(--v-theme-on-surface-variant));
}
.markdown :deep(hr) {
  margin: 0.7em 0;
  border: none;
  border-top: 1px solid rgba(var(--v-border-color), 0.3);
}
.markdown :deep(table) {
  margin: 0.4em 0;
  border-collapse: collapse;
  font-size: 0.9em;
}
.markdown :deep(th),
.markdown :deep(td) {
  padding: 3px 8px;
  border: 1px solid rgba(var(--v-border-color), 0.25);
  text-align: left;
}
.markdown :deep(th) {
  font-weight: 600;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
</style>
