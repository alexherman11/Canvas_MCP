import { z } from 'zod';
import * as canvas from './canvas-api.js';

// ---------------------------------------------------------------------------
// Helper to return a text content block
// ---------------------------------------------------------------------------
function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function error(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

// ---------------------------------------------------------------------------
// Per-request credential resolution
// ---------------------------------------------------------------------------

/**
 * Build a Canvas API context from the MCP request.
 * In remote (HTTP) mode, credentials come from request headers.
 * In local (stdio) mode, they fall back to environment variables.
 */
function getCanvasContext(extra) {
  const headers = extra?.requestInfo?.headers;
  const headerToken = headers?.['x-canvas-api-token'];
  const headerBaseUrl = headers?.['x-canvas-base-url'];

  if (headerToken && headerBaseUrl) {
    const baseUrl = String(headerBaseUrl).replace(/\/+$/, '');
    return { apiBase: `${baseUrl}/api/v1`, apiToken: String(headerToken) };
  }

  // Fall back to env vars (stdio / single-tenant mode)
  const apiToken = process.env.CANVAS_API_TOKEN;
  const baseUrl = process.env.CANVAS_BASE_URL?.replace(/\/+$/, '');
  if (!apiToken || !baseUrl) {
    throw new Error(
      'No Canvas credentials found. Provide x-canvas-api-token and x-canvas-base-url headers, ' +
      'or set CANVAS_BASE_URL and CANVAS_API_TOKEN environment variables.'
    );
  }
  return { apiBase: `${baseUrl}/api/v1`, apiToken };
}

// ---------------------------------------------------------------------------
// Tool definitions: each export is { name, config, handler }
// ---------------------------------------------------------------------------

export const getCourses = {
  name: 'canvas_get_courses',
  config: {
    description:
      'List all active courses for the authenticated Canvas user. Returns course id, name, code, and term.',
    inputSchema: {},
  },
  async handler(_args, extra) {
    const ctx = getCanvasContext(extra);
    const courses = await canvas.getAll(ctx, '/courses', {
      enrollment_state: 'active',
      include: 'term',
      state: 'available',
    });
    const slim = courses.map((c) => ({
      id: c.id,
      name: c.name,
      course_code: c.course_code,
      term: c.term?.name ?? null,
      enrollment_type: c.enrollments?.[0]?.type ?? null,
    }));
    return text(slim);
  },
};

export const getAssignments = {
  name: 'canvas_get_assignments',
  config: {
    description:
      'List assignments for a Canvas course. Includes due dates, points, and submission status.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      include_submission: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include current user submission info'),
    },
  },
  async handler({ course_id, include_submission }, extra) {
    const ctx = getCanvasContext(extra);
    const params = {};
    if (include_submission) params.include = 'submission';
    const assignments = await canvas.getAll(
      ctx,
      `/courses/${course_id}/assignments`,
      params,
    );
    const slim = assignments.map((a) => ({
      id: a.id,
      name: a.name,
      due_at: a.due_at,
      points_possible: a.points_possible,
      submission_types: a.submission_types,
      has_submitted: a.submission?.workflow_state
        ? a.submission.workflow_state !== 'unsubmitted'
        : null,
      score: a.submission?.score ?? null,
      html_url: a.html_url,
    }));
    return text(slim);
  },
};

export const getGrades = {
  name: 'canvas_get_grades',
  config: {
    description:
      'Get current grades for a Canvas course. Returns assignment group grades and overall score.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
    },
  },
  async handler({ course_id }, extra) {
    const ctx = getCanvasContext(extra);
    const enrollments = await canvas.getAll(
      ctx,
      `/courses/${course_id}/enrollments`,
      { user_id: 'self', include: 'current_points' },
    );
    const enrollment = enrollments[0];
    if (!enrollment) return error('No enrollment found for this course.');

    const grades = enrollment.grades ?? {};
    return text({
      course_id,
      current_score: grades.current_score,
      current_grade: grades.current_grade,
      final_score: grades.final_score,
      final_grade: grades.final_grade,
      current_points: enrollment.current_points ?? null,
    });
  },
};

export const getAnnouncements = {
  name: 'canvas_get_announcements',
  config: {
    description: 'Fetch recent announcements for a Canvas course.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Max number of announcements to return (default 10)'),
    },
  },
  async handler({ course_id, limit }, extra) {
    const ctx = getCanvasContext(extra);
    const announcements = await canvas.getAll(ctx, '/announcements', {
      'context_codes[]': `course_${course_id}`,
      per_page: limit,
    });
    const slim = announcements.slice(0, limit).map((a) => ({
      id: a.id,
      title: a.title,
      posted_at: a.posted_at,
      message: a.message?.replace(/<[^>]*>/g, '').slice(0, 500),
      author: a.author?.display_name ?? null,
    }));
    return text(slim);
  },
};

export const getUpcomingDue = {
  name: 'canvas_get_upcoming_due',
  config: {
    description:
      'Get assignments due in the next N days across all courses.',
    inputSchema: {
      days: z
        .number()
        .optional()
        .default(7)
        .describe('Number of days to look ahead (default 7)'),
    },
  },
  async handler({ days }, extra) {
    const ctx = getCanvasContext(extra);
    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 86400000);

    const items = await canvas.getAll(ctx, '/planner/items', {
      start_date: now.toISOString(),
      end_date: cutoff.toISOString(),
      per_page: 100,
    });

    const slim = items.map((item) => ({
      title: item.plannable?.title ?? item.plannable_type,
      course: item.context_name ?? null,
      due_at: item.plannable_date,
      points: item.plannable?.points_possible ?? null,
      submitted: item.submissions?.submitted ?? null,
      type: item.plannable_type,
      html_url: item.html_url,
    }));
    return text(slim);
  },
};

export const submitTextEntry = {
  name: 'canvas_submit_text_entry',
  config: {
    description:
      'Submit a text-based assignment on Canvas. Only works for assignments that accept online_text_entry.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID'),
      body: z.string().describe('The text/HTML body of the submission'),
    },
  },
  async handler({ course_id, assignment_id, body }, extra) {
    const ctx = getCanvasContext(extra);
    const result = await canvas.post(
      ctx,
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      {
        submission: {
          submission_type: 'online_text_entry',
          body,
        },
      },
    );
    return text({
      id: result.id,
      assignment_id: result.assignment_id,
      submitted_at: result.submitted_at,
      workflow_state: result.workflow_state,
    });
  },
};

export const getCourseFiles = {
  name: 'canvas_get_course_files',
  config: {
    description: 'List files available in a Canvas course.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      search_term: z
        .string()
        .optional()
        .describe('Filter files by name (optional)'),
    },
  },
  async handler({ course_id, search_term }, extra) {
    const ctx = getCanvasContext(extra);
    const params = {};
    if (search_term) params.search_term = search_term;
    const files = await canvas.getAll(
      ctx,
      `/courses/${course_id}/files`,
      params,
    );
    const slim = files.map((f) => ({
      id: f.id,
      display_name: f.display_name,
      filename: f.filename,
      size: f.size,
      content_type: f.content_type,
      created_at: f.created_at,
      updated_at: f.updated_at,
      url: f.url,
    }));
    return text(slim);
  },
};

export const sendMessage = {
  name: 'canvas_send_message',
  config: {
    description:
      'Send a Canvas inbox message (conversation) to one or more users.',
    inputSchema: {
      recipients: z
        .array(z.string())
        .describe('Array of recipient Canvas user IDs (as strings)'),
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      course_id: z
        .number()
        .optional()
        .describe('Optional course context for the message'),
    },
  },
  async handler({ recipients, subject, body, course_id }, extra) {
    const ctx = getCanvasContext(extra);
    const payload = {
      recipients,
      subject,
      body,
      group_conversation: true,
    };
    if (course_id) {
      payload.context_code = `course_${course_id}`;
    }
    const result = await canvas.post(ctx, '/conversations', payload);
    return text({
      id: Array.isArray(result) ? result[0]?.id : result.id,
      subject,
      recipients,
      sent: true,
    });
  },
};

// All tools as an array for easy registration
export const allTools = [
  getCourses,
  getAssignments,
  getGrades,
  getAnnouncements,
  getUpcomingDue,
  submitTextEntry,
  getCourseFiles,
  sendMessage,
];
