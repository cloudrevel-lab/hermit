import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

/**
 * Jira worklog comments arrive from the server as Markdown (converted there
 * from Atlassian Document Format) and are rendered here.
 *
 * The content is not ours: it is whatever anyone typed into Jira. So the output
 * goes through two gates — markdown-it runs with `html: false`, which turns raw
 * tags into text rather than markup, and DOMPurify then re-parses the result
 * against the allowlist below. Neither is trusted to be sufficient alone.
 */
const md = new MarkdownIt({
  html: false,
  // Bare URLs someone pasted into a comment should still be clickable.
  linkify: true,
  // ADF hard breaks come across as single newlines.
  breaks: true,
  typographer: false
})

// Comments open Jira issues and build logs; those belong in a new tab, and
// `noopener` keeps the opened page from reaching back through `window.opener`.
const renderLink = md.renderer.rules.link_open ||
  ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts))
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('target', '_blank')
  tokens[i].attrSet('rel', 'noopener noreferrer nofollow')
  return renderLink(tokens, i, opts, env, self)
}

/** Exactly the tags markdown-it can emit for the Markdown the server produces. */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'em', 'strong', 's', 'del', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
]
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'start', 'align']

/** Markdown to sanitised HTML. Returns '' for empty input. */
export function renderMarkdown (text) {
  if (!text) return ''
  return DOMPurify.sanitize(md.render(String(text)), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Belt and braces: markdown-it already refuses javascript: destinations.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  })
}
