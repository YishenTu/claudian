export interface TodoItem {
  /** Imperative description (e.g., "Run tests") */
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present continuous form (e.g., "Running tests") */
  activeForm: string;
}
