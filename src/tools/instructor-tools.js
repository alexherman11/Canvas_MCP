import { z } from 'zod';
import * as canvas from '../canvas-api.js';
import { text, error, getCanvasContext } from './helpers.js';

// ---------------------------------------------------------------------------
// Tier 1 — Instructor daily workflow
// ---------------------------------------------------------------------------

// ---- Assignments ----------------------------------------------------------

export const createAssignment = {
  name: 'canvas_create_assignment',
  config: {
    description:
      'Create a new assignment in a Canvas course. Returns the created assignment with its ID and URL.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      name: z.string().describe('Assignment name/title'),
      description: z.string().optional().describe('Assignment description (HTML)'),
      due_at: z.string().optional().describe('Due date in ISO 8601 format (e.g. 2025-03-15T23:59:00Z)'),
      points_possible: z.number().optional().describe('Maximum points for the assignment'),
      submission_types: z
        .array(z.string())
        .optional()
        .describe('Allowed submission types: "online_text_entry", "online_upload", "online_url", "on_paper", "none"'),
      published: z.boolean().optional().default(false).describe('Whether to publish immediately (default false)'),
      grading_type: z
        .string()
        .optional()
        .describe('Grading type: "points", "percent", "letter_grade", "gpa_scale", "pass_fail", "not_graded"'),
      assignment_group_id: z.number().optional().describe('Assignment group ID to place this assignment in'),
      allowed_extensions: z
        .array(z.string())
        .optional()
        .describe('Allowed file extensions for online_upload (e.g. ["pdf", "docx"])'),
      lock_at: z.string().optional().describe('Lock date in ISO 8601 format'),
      unlock_at: z.string().optional().describe('Unlock date in ISO 8601 format'),
    },
  },
  async handler(args, extra) {
    const ctx = await getCanvasContext(extra);
    const { course_id, ...fields } = args;
    const assignment = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) assignment[k] = v;
    }
    const result = await canvas.post(ctx, `/courses/${course_id}/assignments`, { assignment });
    return text({
      id: result.id,
      name: result.name,
      due_at: result.due_at,
      points_possible: result.points_possible,
      published: result.published,
      html_url: result.html_url,
    });
  },
};

export const editAssignment = {
  name: 'canvas_edit_assignment',
  config: {
    description:
      'Edit an existing assignment in a Canvas course. Only provide the fields you want to change. ' +
      'Note: submission_types cannot be changed after students have submitted.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID to edit'),
      name: z.string().optional().describe('New assignment name/title'),
      description: z.string().optional().describe('New description (HTML)'),
      due_at: z.string().optional().describe('New due date in ISO 8601 format'),
      points_possible: z.number().optional().describe('New maximum points'),
      submission_types: z
        .array(z.string())
        .optional()
        .describe('New submission types (cannot change after students submit)'),
      published: z.boolean().optional().describe('Publish or unpublish the assignment'),
      grading_type: z.string().optional().describe('New grading type'),
      assignment_group_id: z.number().optional().describe('Move to a different assignment group'),
      allowed_extensions: z.array(z.string()).optional().describe('New allowed file extensions'),
      lock_at: z.string().optional().describe('New lock date in ISO 8601 format'),
      unlock_at: z.string().optional().describe('New unlock date in ISO 8601 format'),
    },
  },
  async handler(args, extra) {
    const ctx = await getCanvasContext(extra);
    const { course_id, assignment_id, ...fields } = args;
    const assignment = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) assignment[k] = v;
    }
    const result = await canvas.put(ctx, `/courses/${course_id}/assignments/${assignment_id}`, { assignment });
    return text({
      id: result.id,
      name: result.name,
      due_at: result.due_at,
      points_possible: result.points_possible,
      published: result.published,
      html_url: result.html_url,
    });
  },
};

// ---- Grading --------------------------------------------------------------

export const gradeSubmission = {
  name: 'canvas_grade_submission',
  config: {
    description:
      'Grade a single student submission. Supports points, percentages ("90%"), letter grades, ' +
      '"pass"/"fail"/"complete"/"incomplete", or "excused".',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID'),
      student_id: z.number().describe('The student\'s Canvas user ID'),
      grade: z.string().describe('Grade value: points (e.g. "85"), percentage ("90%"), letter grade ("A-"), "pass", "fail", "complete", "incomplete", or "excused"'),
      comment: z.string().optional().describe('Optional text comment on the submission'),
    },
  },
  async handler({ course_id, assignment_id, student_id, grade, comment }, extra) {
    const ctx = await getCanvasContext(extra);
    const body = { submission: { posted_grade: grade } };
    if (comment) body.comment = { text_comment: comment };
    const result = await canvas.put(
      ctx,
      `/courses/${course_id}/assignments/${assignment_id}/submissions/${student_id}`,
      body,
    );
    return text({
      id: result.id,
      user_id: result.user_id,
      grade: result.grade,
      score: result.score,
      submitted_at: result.submitted_at,
      workflow_state: result.workflow_state,
    });
  },
};

export const bulkGradeSubmissions = {
  name: 'canvas_bulk_grade_submissions',
  config: {
    description:
      'Grade multiple student submissions at once. Processes asynchronously — polls for up to 30 seconds, ' +
      'then returns progress URL if still running.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID'),
      grades: z
        .array(
          z.object({
            student_id: z.number().describe('Student Canvas user ID'),
            grade: z.string().describe('Grade value (same formats as canvas_grade_submission)'),
            comment: z.string().optional().describe('Optional comment for this student'),
          }),
        )
        .describe('Array of grade entries'),
    },
  },
  async handler({ course_id, assignment_id, grades }, extra) {
    const ctx = await getCanvasContext(extra);

    // Build the grade_data hash Canvas expects
    const grade_data = {};
    for (const { student_id, grade, comment } of grades) {
      grade_data[student_id] = { posted_grade: grade };
      if (comment) grade_data[student_id].text_comment = comment;
    }

    const progress = await canvas.post(
      ctx,
      `/courses/${course_id}/assignments/${assignment_id}/submissions/update_grades`,
      { grade_data },
    );

    // Poll for completion (max 30 seconds)
    const progressUrl = `/progress/${progress.id}`;
    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await canvas.get(ctx, progressUrl);
      if (status.workflow_state === 'completed') {
        return text({
          completed: true,
          grades_updated: grades.length,
          message: `Successfully graded ${grades.length} submissions.`,
        });
      }
      if (status.workflow_state === 'failed') {
        return error(`Bulk grading failed: ${status.message || 'Unknown error'}`);
      }
    }

    // Still running after 30s — return progress info
    return text({
      completed: false,
      progress_id: progress.id,
      message: `Grading is still in progress. Check progress at GET /api/v1/progress/${progress.id}`,
    });
  },
};

// ---- Pages & Modules ------------------------------------------------------

export const createPage = {
  name: 'canvas_create_page',
  config: {
    description: 'Create a new wiki page in a Canvas course.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      title: z.string().describe('Page title'),
      body: z.string().optional().describe('Page content (HTML)'),
      published: z.boolean().optional().default(false).describe('Publish immediately (default false)'),
      editing_roles: z
        .string()
        .optional()
        .describe('Who can edit: "teachers", "students", "members", "public"'),
    },
  },
  async handler({ course_id, title, body, published, editing_roles }, extra) {
    const ctx = await getCanvasContext(extra);
    const wiki_page = { title };
    if (body !== undefined) wiki_page.body = body;
    if (published !== undefined) wiki_page.published = published;
    if (editing_roles) wiki_page.editing_roles = editing_roles;
    const result = await canvas.post(ctx, `/courses/${course_id}/pages`, { wiki_page });
    return text({
      page_id: result.page_id ?? result.url,
      title: result.title,
      url: result.url,
      published: result.published,
      html_url: result.html_url,
      updated_at: result.updated_at,
    });
  },
};

export const createModule = {
  name: 'canvas_create_module',
  config: {
    description:
      'Create a new module in a Canvas course. Modules organize content into sections.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      name: z.string().describe('Module name'),
      position: z.number().optional().describe('Position in the module list (1-based)'),
      unlock_at: z.string().optional().describe('Date to unlock the module (ISO 8601)'),
      require_sequential_progress: z
        .boolean()
        .optional()
        .default(false)
        .describe('Require students to complete items in order'),
      published: z.boolean().optional().default(false).describe('Publish immediately (default false)'),
    },
  },
  async handler({ course_id, name, position, unlock_at, require_sequential_progress, published }, extra) {
    const ctx = await getCanvasContext(extra);
    const module = { name };
    if (position !== undefined) module.position = position;
    if (unlock_at) module.unlock_at = unlock_at;
    if (require_sequential_progress) module.require_sequential_progress = true;

    let result = await canvas.post(ctx, `/courses/${course_id}/modules`, { module });

    // Canvas create may not accept published directly — publish via PUT if needed
    if (published && !result.published) {
      result = await canvas.put(ctx, `/courses/${course_id}/modules/${result.id}`, {
        module: { published: true },
      });
    }

    return text({
      id: result.id,
      name: result.name,
      position: result.position,
      published: result.published,
      items_count: result.items_count ?? 0,
    });
  },
};

export const addModuleItem = {
  name: 'canvas_add_module_item',
  config: {
    description:
      'Add an item to an existing module. Items can be assignments, pages, files, discussions, quizzes, ' +
      'subheaders, external URLs, or external tools.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      module_id: z.number().describe('The module ID to add the item to'),
      type: z
        .string()
        .describe('Item type: "Assignment", "Page", "File", "Discussion", "Quiz", "SubHeader", "ExternalUrl", "ExternalTool"'),
      content_id: z
        .number()
        .optional()
        .describe('ID of the content (required for Assignment, File, Discussion, Quiz)'),
      page_url: z
        .string()
        .optional()
        .describe('Page URL slug (required for Page type, e.g. "my-page-title")'),
      title: z
        .string()
        .optional()
        .describe('Display title (required for SubHeader and ExternalUrl)'),
      external_url: z
        .string()
        .optional()
        .describe('URL (required for ExternalUrl type)'),
      position: z.number().optional().describe('Position within the module'),
    },
  },
  async handler({ course_id, module_id, type, content_id, page_url, title, external_url, position }, extra) {
    const ctx = await getCanvasContext(extra);
    const module_item = { type };
    if (content_id !== undefined) module_item.content_id = content_id;
    if (page_url) module_item.page_url = page_url;
    if (title) module_item.title = title;
    if (external_url) module_item.external_url = external_url;
    if (position !== undefined) module_item.position = position;
    const result = await canvas.post(
      ctx,
      `/courses/${course_id}/modules/${module_id}/items`,
      { module_item },
    );
    return text({
      id: result.id,
      module_id: result.module_id,
      type: result.type,
      title: result.title,
      position: result.position,
      content_id: result.content_id,
    });
  },
};

// ---- Announcements --------------------------------------------------------

export const postAnnouncement = {
  name: 'canvas_post_announcement',
  config: {
    description:
      'Post an announcement to a Canvas course. Announcements are immediately visible to all students unless delayed.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      title: z.string().describe('Announcement title'),
      message: z.string().describe('Announcement body (HTML)'),
      delayed_post_at: z
        .string()
        .optional()
        .describe('Schedule for later posting (ISO 8601). If omitted, posts immediately.'),
    },
  },
  async handler({ course_id, title, message, delayed_post_at }, extra) {
    const ctx = await getCanvasContext(extra);
    const body = { title, message, is_announcement: true, published: true };
    if (delayed_post_at) body.delayed_post_at = delayed_post_at;
    const result = await canvas.post(ctx, `/courses/${course_id}/discussion_topics`, body);
    return text({
      id: result.id,
      title: result.title,
      posted_at: result.posted_at,
      message_preview: result.message?.replace(/<[^>]*>/g, '').slice(0, 200),
      html_url: result.html_url,
    });
  },
};

// ---- Analytics ------------------------------------------------------------

export const getCourseAnalytics = {
  name: 'canvas_get_course_analytics',
  config: {
    description:
      'Get course analytics data. Types: "activity" (page views/participations over time), ' +
      '"assignments" (score stats per assignment), "students" (summary per student), ' +
      '"student_activity" (one student\'s activity), "student_assignments" (one student\'s assignment stats).',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      type: z
        .enum(['activity', 'assignments', 'students', 'student_activity', 'student_assignments'])
        .describe('Analytics type to retrieve'),
      student_id: z
        .number()
        .optional()
        .describe('Student Canvas user ID (required for student_activity and student_assignments)'),
    },
  },
  async handler({ course_id, type, student_id }, extra) {
    const ctx = await getCanvasContext(extra);

    if (type.startsWith('student_') && !student_id) {
      return error(`student_id is required for analytics type "${type}".`);
    }

    const paths = {
      activity: `/courses/${course_id}/analytics/activity`,
      assignments: `/courses/${course_id}/analytics/assignments`,
      students: `/courses/${course_id}/analytics/student_summaries`,
      student_activity: `/courses/${course_id}/analytics/users/${student_id}/activity`,
      student_assignments: `/courses/${course_id}/analytics/users/${student_id}/assignments`,
    };

    const data = await canvas.get(ctx, paths[type]);
    return text(data);
  },
};

// ---- Submissions ----------------------------------------------------------

export const listSubmissions = {
  name: 'canvas_list_submissions',
  config: {
    description:
      'List all student submissions for an assignment. Useful for reviewing or grading.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID'),
      include_comments: z.boolean().optional().default(false).describe('Include submission comments'),
      include_rubric: z.boolean().optional().default(false).describe('Include rubric assessment details'),
      include_user: z.boolean().optional().default(true).describe('Include student user info (default true)'),
    },
  },
  async handler({ course_id, assignment_id, include_comments, include_rubric, include_user }, extra) {
    const ctx = await getCanvasContext(extra);
    const includes = [];
    if (include_comments) includes.push('submission_comments');
    if (include_rubric) includes.push('rubric_assessment');
    if (include_user) includes.push('user');

    const params = {};
    if (includes.length) params['include[]'] = includes.join(',');

    const submissions = await canvas.getAll(
      ctx,
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      params,
    );

    const slim = submissions.map((s) => ({
      id: s.id,
      user_id: s.user_id,
      user_name: s.user?.name ?? null,
      grade: s.grade,
      score: s.score,
      submitted_at: s.submitted_at,
      workflow_state: s.workflow_state,
      late: s.late,
      missing: s.missing,
      attempt: s.attempt,
      ...(include_comments && s.submission_comments
        ? { comments: s.submission_comments.map((c) => ({ author: c.author_name, comment: c.comment })) }
        : {}),
    }));
    return text(slim);
  },
};

// ---------------------------------------------------------------------------
// Tier 2 — Course setup
// ---------------------------------------------------------------------------

// ---- Rubrics --------------------------------------------------------------

export const createRubric = {
  name: 'canvas_create_rubric',
  config: {
    description:
      'Create a grading rubric for a course. Optionally attach it to an assignment in one call.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      title: z.string().describe('Rubric title'),
      criteria: z
        .array(
          z.object({
            description: z.string().describe('Criterion description'),
            points: z.number().describe('Maximum points for this criterion'),
            ratings: z
              .array(
                z.object({
                  description: z.string().describe('Rating level description'),
                  points: z.number().describe('Points for this rating level'),
                }),
              )
              .describe('Rating levels from highest to lowest'),
          }),
        )
        .describe('Rubric criteria with rating levels'),
      assignment_id: z
        .number()
        .optional()
        .describe('Assignment ID to attach this rubric to (optional)'),
    },
  },
  async handler({ course_id, title, criteria, assignment_id }, extra) {
    const ctx = await getCanvasContext(extra);

    // Transform criteria array into Canvas indexed hash format
    const criteriaHash = {};
    criteria.forEach((c, i) => {
      const ratingsHash = {};
      c.ratings.forEach((r, j) => {
        ratingsHash[String(j)] = { description: r.description, points: r.points };
      });
      criteriaHash[String(i)] = {
        description: c.description,
        points: c.points,
        ratings: ratingsHash,
      };
    });

    const body = { rubric: { title, criteria: criteriaHash } };

    if (assignment_id) {
      body.rubric_association = {
        association_type: 'Assignment',
        association_id: assignment_id,
        use_for_grading: true,
        purpose: 'grading',
      };
    }

    const result = await canvas.post(ctx, `/courses/${course_id}/rubrics`, body);
    const rubric = result.rubric ?? result;
    return text({
      rubric_id: rubric.id,
      title: rubric.title,
      criteria_count: rubric.data?.length ?? criteria.length,
      associated_assignment_id: assignment_id ?? null,
    });
  },
};

// ---- Quizzes (Classic) ----------------------------------------------------

export const createQuiz = {
  name: 'canvas_create_quiz',
  config: {
    description:
      'Create a quiz in a Canvas course (Classic Quizzes). Add questions separately with canvas_add_quiz_question.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      title: z.string().describe('Quiz title'),
      description: z.string().optional().describe('Quiz instructions/description (HTML)'),
      quiz_type: z
        .string()
        .optional()
        .default('assignment')
        .describe('Quiz type: "practice_quiz", "assignment" (graded), "graded_survey", "survey"'),
      time_limit: z.number().optional().describe('Time limit in minutes (null for no limit)'),
      allowed_attempts: z.number().optional().default(1).describe('Number of attempts allowed (-1 for unlimited)'),
      due_at: z.string().optional().describe('Due date in ISO 8601 format'),
      published: z.boolean().optional().default(false).describe('Publish immediately (default false)'),
      points_possible: z.number().optional().describe('Total points (auto-calculated from questions if omitted)'),
      shuffle_answers: z.boolean().optional().default(false).describe('Shuffle answer choices'),
    },
  },
  async handler(args, extra) {
    const ctx = await getCanvasContext(extra);
    const { course_id, ...fields } = args;
    const quiz = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) quiz[k] = v;
    }
    const result = await canvas.post(ctx, `/courses/${course_id}/quizzes`, { quiz });
    return text({
      id: result.id,
      title: result.title,
      quiz_type: result.quiz_type,
      time_limit: result.time_limit,
      allowed_attempts: result.allowed_attempts,
      due_at: result.due_at,
      published: result.published,
      html_url: result.html_url,
    });
  },
};

export const addQuizQuestion = {
  name: 'canvas_add_quiz_question',
  config: {
    description:
      'Add a question to an existing quiz (Classic Quizzes). For multiple choice, provide answers with weight=100 for correct and weight=0 for incorrect.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      quiz_id: z.number().describe('The quiz ID'),
      question_name: z.string().optional().describe('Question display name/label'),
      question_text: z.string().describe('The question text (HTML)'),
      question_type: z
        .string()
        .describe('Question type: "multiple_choice_question", "true_false_question", "short_answer_question", "essay_question", "numerical_question", "fill_in_multiple_blanks_question", "matching_question"'),
      points_possible: z.number().optional().default(1).describe('Points for this question (default 1)'),
      answers: z
        .array(
          z.object({
            text: z.string().describe('Answer text'),
            weight: z.number().describe('100 for correct answer, 0 for incorrect'),
          }),
        )
        .optional()
        .describe('Answer choices (required for multiple choice, true/false, short answer)'),
    },
  },
  async handler({ course_id, quiz_id, question_name, question_text, question_type, points_possible, answers }, extra) {
    const ctx = await getCanvasContext(extra);
    const question = { question_text, question_type, points_possible };
    if (question_name) question.question_name = question_name;
    if (answers) question.answers = answers;
    const result = await canvas.post(
      ctx,
      `/courses/${course_id}/quizzes/${quiz_id}/questions`,
      { question },
    );
    return text({
      id: result.id,
      question_name: result.question_name,
      question_type: result.question_type,
      points_possible: result.points_possible,
    });
  },
};

// ---- Discussions ----------------------------------------------------------

export const createDiscussion = {
  name: 'canvas_create_discussion',
  config: {
    description: 'Create a discussion topic in a Canvas course.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      title: z.string().describe('Discussion title'),
      message: z.string().optional().describe('Discussion prompt/body (HTML)'),
      discussion_type: z
        .string()
        .optional()
        .default('side_comment')
        .describe('Discussion type: "threaded" (nested replies) or "side_comment" (flat)'),
      pinned: z.boolean().optional().describe('Pin the discussion to the top'),
      published: z.boolean().optional().default(false).describe('Publish immediately (default false)'),
      require_initial_post: z
        .boolean()
        .optional()
        .default(false)
        .describe('Students must post before seeing others\' replies'),
    },
  },
  async handler(args, extra) {
    const ctx = await getCanvasContext(extra);
    const { course_id, ...fields } = args;
    const body = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const result = await canvas.post(ctx, `/courses/${course_id}/discussion_topics`, body);
    return text({
      id: result.id,
      title: result.title,
      discussion_type: result.discussion_type,
      posted_at: result.posted_at,
      published: result.published,
      html_url: result.html_url,
    });
  },
};

// ---- Calendar Events ------------------------------------------------------

export const createCalendarEvent = {
  name: 'canvas_create_calendar_event',
  config: {
    description: 'Create a calendar event for a Canvas course.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID (event will appear on this course\'s calendar)'),
      title: z.string().describe('Event title'),
      start_at: z.string().describe('Start date/time in ISO 8601 format'),
      end_at: z.string().describe('End date/time in ISO 8601 format'),
      description: z.string().optional().describe('Event description (HTML)'),
      location_name: z.string().optional().describe('Location name'),
    },
  },
  async handler({ course_id, title, start_at, end_at, description, location_name }, extra) {
    const ctx = await getCanvasContext(extra);
    const calendar_event = {
      context_code: `course_${course_id}`,
      title,
      start_at,
      end_at,
    };
    if (description) calendar_event.description = description;
    if (location_name) calendar_event.location_name = location_name;
    const result = await canvas.post(ctx, '/calendar_events', { calendar_event });
    return text({
      id: result.id,
      title: result.title,
      start_at: result.start_at,
      end_at: result.end_at,
      location_name: result.location_name,
      html_url: result.html_url,
    });
  },
};

// ---- Assignment Groups & Weighting ----------------------------------------

export const createAssignmentGroup = {
  name: 'canvas_create_assignment_group',
  config: {
    description:
      'Create an assignment group (category) in a course. Groups organize assignments into categories ' +
      'like "Homework", "Exams", "Quizzes". Use canvas_set_group_weights to enable weight-based grading.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      name: z.string().describe('Group name (e.g. "Homework", "Midterm Exams")'),
      group_weight: z
        .number()
        .optional()
        .describe('Weight percentage (e.g. 30 for 30%). Only takes effect if weighting is enabled on the course.'),
      position: z.number().optional().describe('Position in the group list'),
    },
  },
  async handler({ course_id, name, group_weight, position }, extra) {
    const ctx = await getCanvasContext(extra);
    const body = { name };
    if (group_weight !== undefined) body.group_weight = group_weight;
    if (position !== undefined) body.position = position;
    const result = await canvas.post(ctx, `/courses/${course_id}/assignment_groups`, body);
    return text({
      id: result.id,
      name: result.name,
      group_weight: result.group_weight,
      position: result.position,
    });
  },
};

export const setGroupWeights = {
  name: 'canvas_set_group_weights',
  config: {
    description:
      'Enable or disable assignment group weighting for a course. When enabled, each assignment group\'s ' +
      'group_weight percentage determines its contribution to the final grade.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      enable_weighting: z
        .boolean()
        .describe('True to enable weighted grading, false to disable'),
    },
  },
  async handler({ course_id, enable_weighting }, extra) {
    const ctx = await getCanvasContext(extra);
    const result = await canvas.put(ctx, `/courses/${course_id}`, {
      course: { apply_assignment_group_weights: enable_weighting },
    });
    return text({
      course_id: result.id,
      apply_assignment_group_weights: result.apply_assignment_group_weights,
    });
  },
};

// ---- Late Policies --------------------------------------------------------

export const setLatePolicy = {
  name: 'canvas_set_late_policy',
  config: {
    description:
      'Set the late submission and missing submission policies for a course. Each course has one policy — ' +
      'this will create it if it doesn\'t exist, or update the existing one.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      missing_submission_deduction_enabled: z
        .boolean()
        .optional()
        .describe('Enable automatic deduction for missing submissions'),
      missing_submission_deduction: z
        .number()
        .optional()
        .describe('Percent to deduct for missing submissions (e.g. 100 for full deduction)'),
      late_submission_deduction_enabled: z
        .boolean()
        .optional()
        .describe('Enable automatic deduction for late submissions'),
      late_submission_deduction: z
        .number()
        .optional()
        .describe('Percent to deduct per interval for late submissions (e.g. 10 for 10% per day)'),
      late_submission_interval: z
        .string()
        .optional()
        .describe('Deduction interval: "day" or "hour"'),
      late_submission_minimum_percent_enabled: z
        .boolean()
        .optional()
        .describe('Enable a minimum grade floor for late submissions'),
      late_submission_minimum_percent: z
        .number()
        .optional()
        .describe('Minimum grade percentage for late submissions (e.g. 50 means grade can\'t go below 50%)'),
    },
  },
  async handler(args, extra) {
    const ctx = await getCanvasContext(extra);
    const { course_id, ...fields } = args;

    const late_policy = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) late_policy[k] = v;
    }

    // Try POST first (create). If it fails because one already exists, use PATCH (update).
    let result;
    try {
      result = await canvas.post(ctx, `/courses/${course_id}/late_policy`, { late_policy });
    } catch (err) {
      // Policy already exists — update instead
      result = await canvas.patch(ctx, `/courses/${course_id}/late_policy`, { late_policy });
    }

    const policy = result.late_policy ?? result;
    return text({
      course_id,
      late_submission_deduction_enabled: policy.late_submission_deduction_enabled,
      late_submission_deduction: policy.late_submission_deduction,
      late_submission_interval: policy.late_submission_interval,
      late_submission_minimum_percent_enabled: policy.late_submission_minimum_percent_enabled,
      late_submission_minimum_percent: policy.late_submission_minimum_percent,
      missing_submission_deduction_enabled: policy.missing_submission_deduction_enabled,
      missing_submission_deduction: policy.missing_submission_deduction,
    });
  },
};

// ---------------------------------------------------------------------------
// Export all instructor tools
// ---------------------------------------------------------------------------

export const instructorTools = [
  // Tier 1
  createAssignment,
  editAssignment,
  gradeSubmission,
  bulkGradeSubmissions,
  createPage,
  createModule,
  addModuleItem,
  postAnnouncement,
  getCourseAnalytics,
  listSubmissions,
  // Tier 2
  createRubric,
  createQuiz,
  addQuizQuestion,
  createDiscussion,
  createCalendarEvent,
  createAssignmentGroup,
  setGroupWeights,
  setLatePolicy,
];
