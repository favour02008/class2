import {
  router,
  json,
  error,
  requireAuth,
  requireAdminEmailAllowlist,
} from '@appdeploy/sdk';
import { db, storage } from '@appdeploy/sdk';
import { addSubscription, removeSubscriptions, notifySubscribers } from './realtime-subscribers';

const ADMIN_EMAILS = ['favourachigati@gmail.com'];
const adminOnly = [requireAuth(), requireAdminEmailAllowlist(ADMIN_EMAILS)];
const userOnly = [requireAuth()];

async function profileFor(user: {
  userId: string;
  email?: string;
  name?: string;
}) {
  const [existing] = await db.get<any>('profiles', [user.userId], {
    consistent: true,
  });
  if (existing) return existing;
  const isAdmin = (user.email || '').toLowerCase() === ADMIN_EMAILS[0];
  const record = {
    id: user.userId,
    userId: user.userId,
    email: user.email || '',
    name: user.name || '',
    role: isAdmin ? 'admin' : 'pending',
    status: 'Active',
    createdAt: new Date().toISOString(),
  };
  const [created] = await db.tx.add('profiles', [record]);
  if (created) return record;
  const [raced] = await db.get<any>('profiles', [user.userId], {
    consistent: true,
  });
  if (!raced) throw new Error('Could not create your profile. Please retry.');
  return raced;
}

async function requireRole(user: any, allowed: string[]) {
  const profile = await profileFor(user);
  if (!allowed.includes(profile.role))
    throw new Error('Your account does not have permission to do this.');
  return profile;
}

function makeCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'GET /api/me': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await profileFor(ctx.user!);
        const avatarUrl = profile.avatarPath ? (await storage.url([profile.avatarPath]))[0]?.url : undefined;
        return json({ profile: { ...profile, avatarUrl } });
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not load profile',
          500
        );
      }
    },
  ],
  'GET /api/dashboard': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await profileFor(ctx.user!);
        const classPage = await db.list<any>('classrooms', { limit: 100 });
        const assignmentPage = await db.list<any>('assignments', {
          limit: 100,
        });
        const sessionPage = await db.list<any>('attendance_sessions', {
          limit: 100,
        });
        let visibleClasses: any[] = [];
        if (profile.role === 'admin') visibleClasses = classPage.items;
        else if (profile.role === 'teacher')
          visibleClasses = classPage.items.filter(
            c => c.teacherId === ctx.user!.userId
          );
        else if (profile.role === 'student') {
          const enrolments = await db.list<any>('enrolments', { limit: 100 });
          const ids = enrolments.items
            .filter(x => x.studentId === ctx.user!.userId)
            .map(x => x.classId);
          visibleClasses = classPage.items.filter(c => ids.includes(c.id));
        }
        const ids = visibleClasses.map(c => c.id);
        const assignments = assignmentPage.items.filter(a =>
          ids.includes(a.classId)
        );
        const sessions = sessionPage.items.filter(s => ids.includes(s.classId));
        return json({ classes: visibleClasses, assignments, sessions });
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not load dashboard',
          500
        );
      }
    },
  ],
  'PUT /api/profile': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await profileFor(ctx.user!);
        const body = ctx.body as { name?: string; avatarBase64?: string; avatarContentType?: string };
        const name = (body.name || '').trim();
        if (!name || name.length > 70) return error('Enter a name up to 70 characters.', 400);
        const patch: Record<string, unknown> = { name };
        if (body.avatarBase64) {
          const types: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
          const extension = types[body.avatarContentType || ''];
          if (!extension) return error('Use a JPG, PNG or WebP profile picture.', 400);
          if (body.avatarBase64.length > 2800000) return error('Profile picture must be 2 MB or smaller.', 413);
          const path = 'avatars/' + ctx.user!.userId + '/' + Date.now() + '.' + extension;
          const [saved] = await storage.write([{ path, content: body.avatarBase64, contentType: body.avatarContentType! }]);
          if (!saved) return error('Could not save profile picture.', 500);
          patch.avatarPath = path;
        }
        const [updated] = await db.tx.update('profiles', [{ id: ctx.user!.userId, record: patch }], { patch: true });
        if (!updated) return error('Could not update your profile.', 500);
        const [fresh] = await db.get<any>('profiles', [ctx.user!.userId], { consistent: true });
        const avatarUrl = fresh?.avatarPath ? (await storage.url([fresh.avatarPath]))[0]?.url : undefined;
        return json({ profile: { ...fresh, avatarUrl } });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not update profile.', 500); }
    },
  ],
  'GET /api/materials': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await profileFor(ctx.user!);
        if (profile.role === 'pending') return error('Your account is awaiting approval.', 403);
        const classPage = await db.list<any>('classrooms', { limit: 100 });
        let visible = classPage.items;
        if (profile.role === 'teacher') visible = visible.filter(c => c.teacherId === ctx.user!.userId);
        if (profile.role === 'student') {
          const enrollments = await db.list<any>('enrolments', { limit: 100 });
          const ids = enrollments.items.filter(x => x.studentId === ctx.user!.userId).map(x => x.classId);
          visible = visible.filter(c => ids.includes(c.id));
        }
        const ids = visible.map(c => c.id);
        const page = await db.list<any>('class_materials', { limit: 100 });
        const records = page.items.filter(item => ids.includes(item.classId));
        const paths = records.map(item => item.filePath);
        const urls = paths.length ? await storage.url(paths) : [];
        const materials = records.map(item => ({ ...item, className: visible.find(c => c.id === item.classId)?.name || 'Classroom', url: urls.find(u => u.path === item.filePath)?.url || '' }));
        return json({ materials });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not load materials.', 500); }
    },
  ],
  'POST /api/materials': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await requireRole(ctx.user!, ['teacher', 'admin']);
        const body = ctx.body as { title?: string; fileName?: string; contentType?: string; classId?: string; contentBase64?: string };
        if (!body.classId || !body.fileName || !body.contentBase64) return error('Choose a classroom and file.', 400);
        if (body.contentBase64.length > 11200000) return error('Files must be 8 MB or smaller.', 413);
        const [classroom] = await db.get<any>('classrooms', [body.classId], { consistent: true });
        if (!classroom || (profile.role !== 'admin' && classroom.teacherId !== ctx.user!.userId)) return error('You cannot upload to this classroom.', 403);
        const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'image/png', 'image/jpeg'];
        if (!allowed.includes(body.contentType || '')) return error('This file type is not supported.', 415);
        const safeName = body.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
        const filePath = 'class-materials/' + body.classId + '/' + Date.now() + '-' + safeName;
        const [saved] = await storage.write([{ path: filePath, content: body.contentBase64, contentType: body.contentType! }]);
        if (!saved) return error('Could not upload file.', 500);
        const record = { title: (body.title || body.fileName).trim().slice(0, 100), fileName: body.fileName, contentType: body.contentType, classId: body.classId, filePath, uploaderId: ctx.user!.userId, uploaderName: profile.name || ctx.user!.email || 'Teacher', createdAt: new Date().toISOString() };
        const [id] = await db.add('class_materials', [record]);
        if (!id) { await storage.delete([filePath]); return error('Could not save material details.', 500); }
        const [{ url }] = await storage.url([filePath]);
        return json({ material: { ...record, id, className: classroom.name, url } }, 201);
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not upload material.', 403); }
    },
  ],
  'GET /api/community/messages': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['student', 'teacher', 'admin']);
        const page = await db.list<any>('community_messages', { limit: 100 });
        const records = page.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-80);
        const paths = records.filter(m => m.avatarPath).map(m => m.avatarPath);
        const urls = paths.length ? await storage.url(paths) : [];
        return json({ messages: records.map(m => ({ ...m, avatarUrl: urls.find(u => u.path === m.avatarPath)?.url })) });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not load community messages.', 403); }
    },
  ],
  'POST /api/community/messages': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await requireRole(ctx.user!, ['student', 'teacher', 'admin']);
        const body = ctx.body as { text?: string };
        const text = (body.text || '').trim();
        if (!text || text.length > 1000) return error('Messages must be 1–1000 characters.', 400);
        const record = { text, userId: ctx.user!.userId, authorName: profile.name || ctx.user!.email || 'Member', authorRole: profile.role, avatarPath: profile.avatarPath || '', createdAt: new Date().toISOString() };
        const [id] = await db.add('community_messages', [record]);
        if (!id) return error('Could not send message.', 500);
        const avatarUrl = profile.avatarPath ? (await storage.url([profile.avatarPath]))[0]?.url : undefined;
        const message = { ...record, id, avatarUrl };
        await notifySubscribers('community', 'global', message);
        return json({ message }, 201);
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not send message.', 403); }
    },
  ],
  'POST /api/community/subscribe': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['student', 'teacher', 'admin']);
        const body = ctx.body as { connectionId?: string };
        if (!body.connectionId) return error('Connection is required.', 400);
        await addSubscription('community', 'global', body.connectionId);
        return json({ ok: true });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not join chat.', 403); }
    },
  ],
  'POST /api/community/unsubscribe': [
    ...userOnly,
    async ctx => {
      const body = ctx.body as { connectionId?: string };
      if (!body.connectionId) return error('Connection is required.', 400);
      await removeSubscriptions('community', 'global', body.connectionId);
      return json({ ok: true });
    },
  ],
  'GET /api/admin/users': [
    ...adminOnly,
    async () => {
      try {
        const page = await db.list<any>('profiles', { limit: 100 });
        return json({ users: page.items });
      } catch (e) {
        return error('Could not load users', 500);
      }
    },
  ],
  'PUT /api/admin/users/:id': [
    ...adminOnly,
    async ctx => {
      const body = ctx.body as { role?: string };
      if (
        !body.role ||
        !['pending', 'student', 'teacher', 'admin'].includes(body.role)
      )
        return error('Choose a valid role.', 400);
      const [target] = await db.get<any>('profiles', [ctx.params.id], {
        consistent: true,
      });
      if (!target) return error('User not found.', 404);
      if ((target.email || '').toLowerCase() === ADMIN_EMAILS[0])
        return error('The primary administrator role cannot be changed.', 403);
      const [updated] = await db.tx.update(
        'profiles',
        [{ id: ctx.params.id, record: { role: body.role } }],
        { patch: true }
      );
      if (!updated) return error('Could not update this role.', 409);
      return json({ ok: true });
    },
  ],
  'POST /api/classes': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['teacher', 'admin']);
        const body = ctx.body as { name?: string; subject?: string };
        if (!body.name?.trim() || !body.subject?.trim())
          return error('Enter a classroom name and subject.', 400);
        const record = {
          name: body.name.trim(),
          subject: body.subject.trim(),
          code: makeCode(),
          teacherId: ctx.user!.userId,
          createdAt: new Date().toISOString(),
        };
        const [id] = await db.add('classrooms', [record]);
        if (!id) return error('Could not create classroom.', 500);
        return json({ ...record, id }, 201);
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not create classroom',
          403
        );
      }
    },
  ],
  'POST /api/classes/join': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['student']);
        const body = ctx.body as { code?: string };
        if (!body.code) return error('Enter a classroom code.', 400);
        const page = await db.list<any>('classrooms', { limit: 100 });
        const found = page.items.find(c => c.code === body.code!.toUpperCase());
        if (!found) return error('That classroom code was not found.', 404);
        const all = await db.list<any>('enrolments', { limit: 100 });
        if (
          all.items.some(
            x => x.classId === found.id && x.studentId === ctx.user!.userId
          )
        )
          return error('You already joined this classroom.', 409);
        const [id] = await db.add('enrolments', [
          {
            classId: found.id,
            studentId: ctx.user!.userId,
            studentEmail: ctx.user!.email || '',
            createdAt: new Date().toISOString(),
          },
        ]);
        if (!id) return error('Could not join classroom.', 500);
        return json({ ok: true }, 201);
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not join classroom',
          403
        );
      }
    },
  ],
  'POST /api/assignments': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['teacher', 'admin']);
        const body = ctx.body as {
          title?: string;
          description?: string;
          classId?: string;
          dueDate?: string;
        };
        if (!body.title?.trim() || !body.classId)
          return error('Enter a title and choose a classroom.', 400);
        const [classroom] = await db.get<any>('classrooms', [body.classId], {
          consistent: true,
        });
        if (
          !classroom ||
          (classroom.teacherId !== ctx.user!.userId &&
            (ctx.user!.email || '').toLowerCase() !== ADMIN_EMAILS[0])
        )
          return error('You cannot publish to this classroom.', 403);
        const record = {
          title: body.title.trim(),
          description: body.description || '',
          classId: body.classId,
          dueDate: body.dueDate || '',
          teacherId: ctx.user!.userId,
          createdAt: new Date().toISOString(),
        };
        const [id] = await db.add('assignments', [record]);
        if (!id) return error('Could not publish assignment.', 500);
        return json({ ...record, id }, 201);
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not publish assignment',
          403
        );
      }
    },
  ],
  'POST /api/attendance/start': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['teacher', 'admin']);
        const body = ctx.body as { classId?: string };
        if (!body.classId) return error('Choose a classroom.', 400);
        const [classroom] = await db.get<any>('classrooms', [body.classId], {
          consistent: true,
        });
        if (
          !classroom ||
          (classroom.teacherId !== ctx.user!.userId &&
            (ctx.user!.email || '').toLowerCase() !== ADMIN_EMAILS[0])
        )
          return error('You cannot start attendance for this class.', 403);
        const record = {
          classId: body.classId,
          code: makeCode(),
          teacherId: ctx.user!.userId,
          createdAt: new Date().toISOString(),
        };
        const [id] = await db.add('attendance_sessions', [record]);
        if (!id) return error('Could not start attendance.', 500);
        return json({ ...record, id }, 201);
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not start attendance',
          403
        );
      }
    },
  ],
  'GET /api/live-classes': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await requireRole(ctx.user!, ['student', 'teacher', 'admin']);
        const page = await db.list<any>('live_class_sessions', { limit: 100 });
        const classPage = await db.list<any>('classrooms', { limit: 100 });
        let visibleClasses = classPage.items;
        if (profile.role === 'teacher') visibleClasses = visibleClasses.filter(c => c.teacherId === ctx.user!.userId);
        if (profile.role === 'student') {
          const enrolments = await db.list<any>('enrolments', { limit: 100 });
          const ids = enrolments.items.filter(x => x.studentId === ctx.user!.userId).map(x => x.classId);
          visibleClasses = visibleClasses.filter(c => ids.includes(c.id));
        }
        const ids = visibleClasses.map(c => c.id);
        const sessions = page.items.filter(s => ids.includes(s.classId)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return json({ sessions });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not load live classes.', 403); }
    },
  ],
  'POST /api/live-classes': [
    ...userOnly,
    async ctx => {
      try {
        const profile = await requireRole(ctx.user!, ['teacher', 'admin']);
        const body = ctx.body as { classId?: string; title?: string; meetingUrl?: string; scheduledAt?: string };
        if (!body.classId || !body.title?.trim() || !body.meetingUrl?.trim()) return error('Choose a class, enter a title and paste a Google Meet link.', 400);
        let parsed: URL;
        try { parsed = new URL(body.meetingUrl); } catch { return error('Enter a valid Google Meet URL.', 400); }
        if (parsed.protocol !== 'https:' || !['meet.google.com', 'www.google.com'].includes(parsed.hostname)) return error('Use a Google Meet link beginning with https://meet.google.com/.', 400);
        const [classroom] = await db.get<any>('classrooms', [body.classId], { consistent: true });
        if (!classroom || (profile.role !== 'admin' && classroom.teacherId !== ctx.user!.userId)) return error('You cannot schedule a session for this classroom.', 403);
        const record = { classId: body.classId, title: body.title.trim().slice(0, 100), meetingUrl: body.meetingUrl.trim(), scheduledAt: body.scheduledAt || '', teacherId: ctx.user!.userId, teacherName: profile.name || ctx.user!.email || 'Teacher', createdAt: new Date().toISOString() };
        const [id] = await db.add('live_class_sessions', [record]);
        if (!id) return error('Could not create the live class session.', 500);
        return json({ session: { ...record, id } }, 201);
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not create live class.', 403); }
    },
  ],
  'GET /api/attendance/summary': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['student']);
        const enrolments = await db.list<any>('enrolments', { limit: 100 });
        const classIds = enrolments.items.filter(x => x.studentId === ctx.user!.userId).map(x => x.classId);
        const classPage = await db.list<any>('classrooms', { limit: 100 });
        const classes = classPage.items.filter(c => classIds.includes(c.id));
        const sessionsPage = await db.list<any>('attendance_sessions', { limit: 100 });
        const sessions = sessionsPage.items.filter(s => classIds.includes(s.classId));
        const recordsPage = await db.list<any>('attendance_records', { limit: 100 });
        const ownRecords = recordsPage.items.filter(r => r.studentId === ctx.user!.userId);
        const summary = classes.map(classroom => {
          const classSessions = sessions.filter(s => s.classId === classroom.id);
          const attendedIds = new Set(ownRecords.filter(r => classSessions.some(s => s.id === r.sessionId)).map(r => r.sessionId));
          return { classId: classroom.id, className: classroom.name, total: classSessions.length, attended: attendedIds.size, missed: Math.max(0, classSessions.length - attendedIds.size), records: classSessions.map(s => ({ id: s.id, createdAt: s.createdAt, attended: attendedIds.has(s.id) })) };
        });
        return json({ summary });
      } catch (e) { return error(e instanceof Error ? e.message : 'Could not load attendance summary.', 403); }
    },
  ],
  'POST /api/attendance/mark': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['student']);
        const body = ctx.body as { code?: string };
        if (!body.code) return error('Enter the attendance code.', 400);
        const page = await db.list<any>('attendance_sessions', { limit: 100 });
        const session = page.items.find(
          s => s.code === body.code!.toUpperCase()
        );
        if (!session) return error('That attendance code is not active.', 404);
        const records = await db.list<any>('attendance_records', {
          limit: 100,
        });
        if (
          records.items.some(
            r => r.sessionId === session.id && r.studentId === ctx.user!.userId
          )
        )
          return error('You are already marked present.', 409);
        const [id] = await db.add('attendance_records', [
          {
            sessionId: session.id,
            classId: session.classId,
            studentId: ctx.user!.userId,
            studentEmail: ctx.user!.email || '',
            createdAt: new Date().toISOString(),
          },
        ]);
        if (!id) return error('Could not mark attendance.', 500);
        return json({ ok: true }, 201);
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not mark attendance',
          403
        );
      }
    },
  ],
  'GET /api/attendance/:classId': [
    ...userOnly,
    async ctx => {
      try {
        await requireRole(ctx.user!, ['teacher', 'admin']);
        const [classroom] = await db.get<any>(
          'classrooms',
          [ctx.params.classId],
          { consistent: true }
        );
        if (
          !classroom ||
          (classroom.teacherId !== ctx.user!.userId &&
            (ctx.user!.email || '').toLowerCase() !== ADMIN_EMAILS[0])
        )
          return error('You cannot view this class attendance.', 403);
        const page = await db.list<any>('attendance_records', { limit: 100 });
        const attendance = page.items.filter(
          r => r.classId === ctx.params.classId
        );
        return json({ attendance });
      } catch (e) {
        return error(
          e instanceof Error ? e.message : 'Could not load attendance',
          403
        );
      }
    },
  ],
});
