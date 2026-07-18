/**
 * Schedule entry types shared between backend and frontend.
 *
 * @module
 */

/** A registered job scheduler entry (from the scheduler extension). */
export interface ScheduleEntry {
  id: string;
  name: string;
  next: number;
  pattern?: string;
  every?: number;
  /** Maximum number of executions (omit for infinite). */
  limit?: number;
  /** Number of times this scheduler has already fired. */
  executions: number;
  /** Human-readable description of what this schedule does. */
  description?: string;
}
