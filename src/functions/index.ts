import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { askClarificationFunction } from './askClarification';
import { createTaskFunction } from './createTask';
import { findTaskFunction } from './findTask';
import { listTasksFunction } from './listTasks';
import { deleteTaskFunction } from './deleteTask';
import { deleteTasksFunction } from './deleteTasks';
import { updateTaskStatusFunction } from './updateTaskStatus';
import { updateTaskDetailsFunction } from './updateTaskDetails';
import { nudgeProgressFunction } from './nudgeProgress';
import { recordProgressFunction } from './recordProgress';
import { confirmAliasFunction } from './confirmAlias';

export function registerCoreFunctions(registry: FunctionRegistry) {
  registry.register(askClarificationFunction());
  registry.register(createTaskFunction());
  registry.register(findTaskFunction());
  registry.register(listTasksFunction());
  registry.register(updateTaskDetailsFunction());
  registry.register(updateTaskStatusFunction());
  registry.register(nudgeProgressFunction());
  registry.register(recordProgressFunction());
  registry.register(deleteTaskFunction());
  registry.register(deleteTasksFunction());
  registry.register(confirmAliasFunction());
}
