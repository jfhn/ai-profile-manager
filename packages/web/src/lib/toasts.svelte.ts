import { errorMessage } from './api';

export type ToastVariant = 'neutral' | 'destructive';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

const DISMISS_AFTER = 5000;

let nextId = 1;

class ToastStore {
  items = $state<Toast[]>([]);

  push(title: string, options: { description?: string; variant?: ToastVariant } = {}): void {
    const id = nextId++;
    const toast: Toast = {
      id,
      title,
      variant: options.variant ?? 'neutral',
      ...(options.description === undefined ? {} : { description: options.description }),
    };
    this.items = [...this.items, toast];
    setTimeout(() => this.dismiss(id), DISMISS_AFTER);
  }

  dismiss(id: number): void {
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new ToastStore();

export function toast(title: string, description?: string): void {
  toasts.push(title, description === undefined ? {} : { description });
}

/** Report an unhandled error from an action. */
export function toastError(error: unknown, context?: string): void {
  const message = errorMessage(error);
  toasts.push(context ?? 'Something went wrong', {
    description: message,
    variant: 'destructive',
  });
}
