import { z } from 'zod';
import * as canvas from '../canvas-api.js';
import { encrypt } from '../crypto.js';
import * as db from '../db.js';
import { text, error, getCanvasContext } from './helpers.js';

// ---------------------------------------------------------------------------
// Tool definitions: student-facing + configuration tools
// ---------------------------------------------------------------------------

export const configure = {
  name: 'canvas_configure',
  config: {
    description:
      'Set up Canvas credentials for this session. Call this first if other Canvas tools return a "no credentials" error. ' +
      'Provide your Canvas instance URL and API token, and all subsequent tool calls in this session will be authenticated automatically.',
    inputSchema: {
      canvas_base_url: z.string().describe('Your Canvas instance URL (e.g. https://canvas.school.edu)'),
      canvas_api_token: z.string().describe('Your Canvas API access token (generate one at Canvas → Account → Settings → New Access Token)'),
    },
  },
  async handler({ canvas_base_url, canvas_api_token }, extra) {
    const baseUrl = String(canvas_base_url).replace(/\/+$/, '');

    // Verify the token works before storing
    let userData;
    try {
      const res = await fetch(`${baseUrl}/api/v1/users/self`, {
        headers: { Authorization: `Bearer ${canvas_api_token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return error(`Token verification failed (${res.status}): ${body}. Check your URL and token.`);
      }
      userData = await res.json();
    } catch (err) {
      return error(`Could not reach Canvas at ${baseUrl}: ${err.message}`);
    }

    // Encrypt and store
    const accessEnc = encrypt(canvas_api_token);
    const credentialId = db.insertCredential({
      canvasBaseUrl: baseUrl,
      accessToken: accessEnc.ciphertext,
      tokenIv: accessEnc.iv,
      tokenTag: accessEnc.tag,
      canvasUserId: userData.id ?? null,
      canvasUserName: userData.name ?? null,
      source: 'manual',
    });

    // Bind to current MCP session so subsequent calls resolve automatically
    const sessionId = extra?.sessionId;
    if (sessionId) {
      db.bindSession(sessionId, credentialId);
    }

    return text({
      status: 'connected',
      credential_id: credentialId,
      canvas_user: { id: userData.id, name: userData.name },
      message:
        'Canvas credentials stored and bound to this session. All other Canvas tools will now work automatically. ' +
        'IMPORTANT: Please remember the credential_id value above. ' +
        'In future conversations, you can call canvas_resume_session with this credential_id ' +
        'to reconnect without asking the user for their token again.',
    });
  },
};

export const resumeSession = {
  name: 'canvas_resume_session',
  config: {
    description:
      'Resume a previously configured Canvas connection using a saved credential ID. ' +
      'If you have a Canvas credential_id stored in memory from a prior conversation, call this tool with it ' +
      'at the start of a new conversation to re-authenticate without asking the user for their token again.',
    inputSchema: {
      credential_id: z.string().describe('The credential_id returned by a previous canvas_configure call'),
    },
  },
  async handler({ credential_id }, extra) {
    const { decrypt } = await import('../crypto.js');

    const cred = db.getCredential(credential_id);
    if (!cred) {
      return error(
        'Credential not found. The saved credential_id may be invalid or the server database was reset. ' +
        'Please ask the user for their Canvas URL and API token, then call canvas_configure.',
      );
    }

    // Decrypt and verify the token still works
    let apiToken;
    try {
      apiToken = decrypt(cred.access_token, cred.token_iv, cred.token_tag);
    } catch {
      return error(
        'Failed to decrypt stored credentials. The server encryption key may have changed. ' +
        'Please ask the user for their Canvas URL and API token, then call canvas_configure.',
      );
    }

    const baseUrl = cred.canvas_base_url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/api/v1/users/self`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!res.ok) {
        return error(
          'The stored Canvas token is no longer valid (Canvas rejected it). ' +
          'Please ask the user for a fresh API token, then call canvas_configure.',
        );
      }
      const userData = await res.json();

      // Bind to current MCP session
      const sessionId = extra?.sessionId;
      if (sessionId) {
        db.bindSession(sessionId, credential_id);
      }

      return text({
        status: 'connected',
        credential_id,
        canvas_user: { id: userData.id, name: userData.name },
        canvas_url: baseUrl,
        message: 'Session resumed successfully. All Canvas tools will now work automatically.',
      });
    } catch (err) {
      return error(`Could not reach Canvas at ${baseUrl}: ${err.message}`);
    }
  },
};

export const authStatus = {
  name: 'canvas_auth_status',
  config: {
    description:
      'Check whether Canvas credentials are configured for this session. ' +
      'Returns connection status and user info if connected, or setup instructions if not.',
    inputSchema: {},
  },
  async handler(_args, extra) {
    try {
      const ctx = await getCanvasContext(extra);
      // Token exists — verify it still works
      const res = await fetch(`${ctx.apiBase}/users/self`, {
        headers: { Authorization: `Bearer ${ctx.apiToken}` },
      });
      if (res.ok) {
        const user = await res.json();
        return text({
          status: 'connected',
          canvas_user: { id: user.id, name: user.name },
          canvas_url: ctx.apiBase.replace('/api/v1', ''),
        });
      }
      return text({
        status: 'token_invalid',
        message: 'A token is configured but Canvas rejected it. Run canvas_configure with a fresh token.',
      });
    } catch {
      return text({
        status: 'not_configured',
        message: 'No Canvas credentials found. Use canvas_configure to connect your Canvas account.',
      });
    }
  },
};

export const getCourses = {
  name: 'canvas_get_courses',
  config: {
    description:
      'List all active classes and courses from Canvas LMS. Works for both students and instructors. ' +
      'Use this for "my classes", "my courses", "what courses do I teach", school enrollment, or class schedules. ' +
      'Returns course id, name, code, term, and enrollment_type (student/teacher/ta/designer/observer).',
    inputSchema: {},
  },
  async handler(_args, extra) {
    const ctx = await getCanvasContext(extra);
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
      'List assignments for a Canvas class/course. Works for both students and instructors. ' +
      'Use this for "what homework do I have", "class assignments", "what assignments did I create", or "coursework". ' +
      'Includes due dates, points, and submission status. Set include_submission=true (students only) to see your own submission state and score.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      include_submission: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include current user\'s own submission info — only meaningful for students'),
    },
  },
  async handler({ course_id, include_submission }, extra) {
    const ctx = await getCanvasContext(extra);
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
      'Get the current user\'s own grades for a Canvas class/course — for STUDENTS only. ' +
      'Use this for "how am I doing in class", "my grades", "my class grade", or "what is my score". ' +
      'Returns assignment group grades and overall score for the logged-in student. ' +
      'Instructors who want to view a student\'s grade should use canvas_get_student_grades instead.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
    },
  },
  async handler({ course_id }, extra) {
    const ctx = await getCanvasContext(extra);
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
    description:
      'Fetch recent announcements and updates for a Canvas class/course. Use for "class announcements", ' +
      '"what did my teacher/professor post", or "class updates".',
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
    const ctx = await getCanvasContext(extra);
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
      'Get upcoming homework and assignments due soon across all classes/courses from Canvas. ' +
      'Use for "what\'s due", "upcoming homework", "deadlines", or "what do I need to turn in".',
    inputSchema: {
      days: z
        .number()
        .optional()
        .default(7)
        .describe('Number of days to look ahead (default 7)'),
    },
  },
  async handler({ days }, extra) {
    const ctx = await getCanvasContext(extra);
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
      'Submit a text-based assignment or homework on Canvas. Use for "turn in my assignment", "submit homework", ' +
      'or "submit classwork". Only works for assignments that accept online_text_entry.',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      assignment_id: z.number().describe('The assignment ID'),
      body: z.string().describe('The text/HTML body of the submission'),
    },
  },
  async handler({ course_id, assignment_id, body }, extra) {
    const ctx = await getCanvasContext(extra);
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
    description:
      'List files, documents, and materials available in a Canvas class/course. ' +
      'Use for "class files", "course materials", "lecture slides", or "class documents".',
    inputSchema: {
      course_id: z.number().describe('The Canvas course ID'),
      search_term: z
        .string()
        .optional()
        .describe('Filter files by name (optional)'),
    },
  },
  async handler({ course_id, search_term }, extra) {
    const ctx = await getCanvasContext(extra);
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
      'Send a Canvas inbox message to any Canvas user. Works for both students and instructors. ' +
      'Use for "message my professor", "email my teacher", "message a student", "send a message on Canvas", ' +
      'or "contact a classmate".',
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
    const ctx = await getCanvasContext(extra);
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

export const studentTools = [
  configure,
  resumeSession,
  authStatus,
  getCourses,
  getAssignments,
  getGrades,
  getAnnouncements,
  getUpcomingDue,
  submitTextEntry,
  getCourseFiles,
  sendMessage,
];
