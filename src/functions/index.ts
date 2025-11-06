import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { createTaskFunction } from './createTask';
import { listTasksFunction } from './listTasks';
import { deleteTaskFunction } from './deleteTask';
import { updateTaskStatusFunction } from './updateTaskStatus';

export function registerCoreFunctions(registry: FunctionRegistry) {
  registry.register(createTaskFunction());
  registry.register(listTasksFunction());
  registry.register(deleteTaskFunction());
  registry.register(updateTaskStatusFunction());
}

