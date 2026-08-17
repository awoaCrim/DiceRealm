# Client Component Guidelines

Use small function components with typed props. Pages compose feature sections; shared UI components handle repeated loading, error, and layout behavior.

## Component boundaries

- A component consumes parsed contract data or a hook result; it does not parse arbitrary network JSON.
- Use `AsyncState` for a single block's loading/empty/error/retry presentation. Feature pages may compose higher-level domain states such as locked or resolving.
- Keep mutations in entity hooks and pass callbacks/data into presentational components.
- Reuse `TurnEntries` and `TurnStoryHistory` for owner/player story rendering; do not duplicate visibility filtering in a page.

```tsx
export function AsyncState({ status, label, errorMessage, onRetry, children }: AsyncStateProps) {
  if (status === 'error') {
    return <div role="alert"><p>{label}加载失败。</p>{onRetry && <button onClick={onRetry}>重试</button>}</div>;
  }
  return status === 'ready' ? <>{children}</> : <div role="status">正在加载{label}…</div>;
}
```

## Props and styling

Define a local `Props` interface when props are non-trivial. Use semantic HTML, existing class-name conventions, and the shared `styles.css`; this project does not use Tailwind or CSS-in-JS.

Interactive controls need accessible names, keyboard behavior, and visible state. Do not render raw JSON or unknown payloads directly; use safe readers and a fallback message.
