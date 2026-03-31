export { studentTools } from './student-tools.js';
export { instructorTools } from './instructor-tools.js';

import { studentTools } from './student-tools.js';
import { instructorTools } from './instructor-tools.js';

export const allTools = [...studentTools, ...instructorTools];
