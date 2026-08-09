/**
 * Top-level Error Boundary (per ADR-0038 — full-stack error handling).
 *
 * Catches render-phase + lifecycle errors in the React tree (does NOT
 * catch event handler errors / async errors — those are surfaced via
 * React Query's `onError` + axios interceptor chain).
 *
 * Display:
 *   - Friendly headline (`出错了`)
 *   - formatted error message via formatErrorMessage()
 *   - trace_id grey fine print (user screenshot → backend log grep)
 *   - "重试" button that re-mounts the subtree
 *
 * Not a class with hooks because React only supports componentDidCatch
 * in classes; we keep it minimal and use the standalone formatErrorMessage
 * + extractTraceId helpers from ./api/errors.
 */
import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { extractTraceId, formatErrorMessage } from './api/errors';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

const INITIAL_STATE: ErrorBoundaryState = { hasError: false, error: null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = INITIAL_STATE;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    // Log to console so it shows up in `expo start` / RN dev tools.
    // Plan 3 introduces Sentry / Bugsnag in this hook.
    console.error(`[ErrorBoundary] trace=${extractTraceId(error)}`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState(INITIAL_STATE);
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const message = formatErrorMessage(this.state.error);
    const traceId = extractTraceId(this.state.error);
    return (
      <View style={styles.root} testID="error-boundary.fallback">
        <Text style={styles.headline}>出错了</Text>
        <Text style={styles.message}>{message}</Text>
        <Pressable
          accessibilityRole="button"
          style={styles.retry}
          onPress={this.handleRetry}
          testID="error-boundary.retry"
        >
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
        <Text style={styles.trace}>trace_id: {traceId}</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  headline: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: '#444',
    marginBottom: 24,
    textAlign: 'center',
  },
  retry: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    backgroundColor: '#222',
    borderRadius: 8,
    marginBottom: 16,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
  },
  trace: {
    fontSize: 10,
    color: '#999',
  },
});
