// Ambient declarations for side-effect-only imports we use across plugin
// UIs and SDK code. Picked up workspace-wide via the root tsconfig's include
// of `packages/sdk-react/src`.

// CSS imports are runtime side effects (Vite handles them); we just need
// TypeScript to stop complaining about the missing module shape.
declare module '*.css';
declare module '*.scss';

// Static asset imports - default export is the URL string the bundler emits.
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.png' {
  const url: string;
  export default url;
}
