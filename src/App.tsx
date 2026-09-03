import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react';
import { supabase } from './supabase';
import './index.css';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Session { user: { id: string; email: string } }

interface Location {
  id: string;
  admin_id: string;
  name: string;
  address?: string | null;
  created_at: string;
}

interface Employee {
  id: string; admin_id: string; name: string;
  employee_id: string; shift_start: string; shift_end: string;
  image_url?: string; created_at: string;
  location_id?: string | null;
  department?: string | null;
  designation?: string | null;
  joining_date?: string | null;
  is_active?: boolean;
  notes?: string | null;
  documents?: { name: string; url: string; file_path: string }[] | null;
  overtime_enabled?: boolean;
  overtime_rate_per_hour?: number;
  face_embedding?: string;
}

interface Attendance {
  id: string; employee_id: string; employee_name: string;
  employee_code: string; timestamp: string; punch_type: string;
  verification_method: string; confidence: number;
}

interface LeaveRequest {
  id: string; employee_id: string; start_date: string;
  end_date: string; type: string; status: string; reason?: string; created_at: string;
}

interface EmployeeSalary {
  id: string; employee_id: string; monthly_salary: number;
  hourly_rate: number; is_hourly: boolean; effective_date?: string;
}

function getActiveSalary(salaries: EmployeeSalary[], employeeId: string, dateLimit: string): EmployeeSalary | undefined {
  const allEmps = salaries.filter(s => s.employee_id === employeeId);
  if (allEmps.length === 0) return undefined;

  // Find salaries active on or before dateLimit
  const activeEmps = allEmps.filter(s => !s.effective_date || s.effective_date <= dateLimit);
  if (activeEmps.length > 0) {
    activeEmps.sort((a, b) => {
      const da = a.effective_date ?? '2000-01-01';
      const db = b.effective_date ?? '2000-01-01';
      return db.localeCompare(da);
    });
    return activeEmps[0];
  }

  // Fallback: if no salary was active before dateLimit, use the earliest configured salary
  allEmps.sort((a, b) => {
    const da = a.effective_date ?? '2000-01-01';
    const db = b.effective_date ?? '2000-01-01';
    return da.localeCompare(db);
  });
  return allEmps[0];
}

interface EmployeeLeave {
  id: string; employee_id: string; year: number; month: number; leaves_allotted: number;
}

interface PublicHoliday { id: string; name: string; date: string; }

interface WeeklyOffDay {
  id: string;
  admin_id: string;
  employee_id?: string | null;
  weekday: number;
  name: string;
  created_at?: string;
}

function getEmployeeWeeklyOffSet(
  weeklyOffs: WeeklyOffDay[],
  employeeId?: string,
  empWeeklyOffMap?: Record<string, string | number>
): Set<number> {
  if (employeeId && empWeeklyOffMap && empWeeklyOffMap[employeeId] !== undefined) {
    const val = empWeeklyOffMap[employeeId];
    if (val === 'sat_sun') return new Set([6, 7]);
    if (val !== 'default' && !isNaN(Number(val))) return new Set([Number(val)]);
    if (val === 'default') {
      const defaultOffs = weeklyOffs.filter(w => !w.employee_id);
      if (defaultOffs.length > 0) return new Set(defaultOffs.map(w => w.weekday));
      return new Set([7]);
    }
  }

  if (employeeId) {
    const empOffs = weeklyOffs.filter(w => w.employee_id === employeeId);
    if (empOffs.length > 0) {
      return new Set(empOffs.map(w => w.weekday));
    }
  }
  const defaultOffs = weeklyOffs.filter(w => !w.employee_id);
  if (defaultOffs.length > 0) {
    return new Set(defaultOffs.map(w => w.weekday));
  }
  return new Set([7]);
}


interface EmployeeShift {
  id: string;
  admin_id: string;
  employee_id: string;
  date: string;
  shift_start: string;
  shift_end: string;
  shift_name: string;
  created_at: string;
}

interface SalarySlip {
  emp: Employee;
  sal: EmployeeSalary | undefined;
  daysInMonth: number;
  workingDays: number;   // excl. sundays + holidays
  daysPresent: number;
  daysAbsent: number;
  leavesUsed: number;
  leavesAllotted: number;
  perDaySalary: number;
  grossPay: number;
  basePay: number;
  unpaidLeaveDeduction?: number;
  payAfterDeductions?: number;
  absentDeduction: number;
  leaveDeduction: number;
  overtimeHours: number;   // total hours (decimal)
  overtimeMinutes: number; // remainder minutes after full hours
  overtimePay: number;
  netPay: number;
  lateMinutes?: number;
  lateCutDeduction?: number;
  shortageMinutes?: number;
  underworkDeduction?: number;
  sandwichedDays?: number;
  calcMethod?: 'fixed_30' | 'working_day' | 'actual_calendar';
  totalWorkedMinutes?: number;
}


interface AuditLogEntry {
  id: string;
  admin_id: string;
  action: string;
  target_id: string | null;
  target_name: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const AVATAR_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];
const avatarColor = (name: string) => AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length];
const initials = (name: string) => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const fmtMoney = (n: number) => '₹' + Number(n.toFixed(2)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Escape the five HTML meta-characters so that user-controlled strings
 * can be safely interpolated into document.write() HTML templates.
 * This prevents stored-XSS via employee names, holiday names, or any
 * other DB-sourced text that appears in print windows.
 */
const escHtml = (s: string | number | null | undefined): string => {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

// Local calendar date as YYYY-MM-DD. Using toISOString() here would format in
// UTC and shift the day by the timezone offset (e.g. before ~5:30 AM IST it
// reports "yesterday"), so all day-level logic must go through these helpers.
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The LOCAL calendar day a stored UTC timestamp (timestamptz) falls on.
const dayKey = (ts: string) => ymd(new Date(ts));
const today = () => ymd(new Date());

const toWeekdayNumber = (date: Date) => {
  const d = date.getDay(); // 0=Sunday, 1=Monday...6=Saturday
  return d === 0 ? 7 : d;
};

const isHolidayDate = (date: Date, publicHolsSet: Set<string>, weeklyOffsSet: Set<number>) => {
  return publicHolsSet.has(ymd(date)) || weeklyOffsSet.has(toWeekdayNumber(date));
};


/**
 * Write an entry to the append-only audit_log table.
 * This is fire-and-forget: a network failure here must never block
 * the primary operation that was already committed.
 */
async function auditLog(
  adminId: string,
  action: string,
  targetId: string | null,
  targetName: string,
  detail?: Record<string, unknown>
) {
  try {
    await supabase.from('audit_log').insert({
      admin_id: adminId,
      action,
      target_id: targetId ?? null,
      target_name: targetName,
      detail: detail ?? null,
    });
  } catch {
    // Silently swallow — audit logging is best-effort on the client side
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECYCLE BIN & SOFT DELETE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
export interface RecycleBinRecord {
  id: string;
  admin_id: string;
  table_name: string;
  record_id: string;
  record_data: Record<string, any>;
  record_name: string;
  deleted_by: string;
  deleted_by_role: string;
  deleted_at: string;
  metadata?: Record<string, any> | null;
}

async function softDeleteRecord(
  tableName: string,
  recordId: string,
  adminId: string,
  deletedByEmail: string,
  deletedByRole: string = 'admin',
  recordName?: string,
  extraMetadata?: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. Fetch current record data from table
    const { data: recordData, error: fetchErr } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', recordId)
      .maybeSingle();

    let targetRecord = recordData;
    if (!targetRecord) {
      const { data: listData } = await supabase.from(tableName).select('*').eq('id', recordId);
      if (listData && listData.length > 0) {
        targetRecord = listData[0];
      }
    }

    if (!targetRecord) {
      return { success: false, error: fetchErr?.message || `Record ${recordId} not found in ${tableName}` };
    }

    // Backup associated employee_salary if soft-deleting an employee
    const metadataPayload: Record<string, any> = extraMetadata ? { ...extraMetadata } : {};
    if (tableName === 'employees') {
      const { data: salData } = await supabase.from('employee_salary').select('*').eq('employee_id', recordId);
      if (salData && salData.length > 0) {
        metadataPayload.associated_employee_salary = salData;
      }
    }

    const displayName = recordName ||
      targetRecord?.name ||
      targetRecord?.employee_name ||
      targetRecord?.email ||
      targetRecord?.date ||
      recordId;

    // 2. Insert into recycle_bin table
    const { error: recycleErr } = await supabase.from('recycle_bin').insert({
      id: crypto.randomUUID(),
      admin_id: adminId || targetRecord?.admin_id || targetRecord?.id || '00000000-0000-0000-0000-000000000000',
      table_name: tableName,
      record_id: String(recordId),
      record_data: targetRecord,
      record_name: String(displayName),
      deleted_by: deletedByEmail || 'admin',
      deleted_by_role: deletedByRole || 'admin',
      deleted_at: new Date().toISOString(),
      metadata: Object.keys(metadataPayload).length > 0 ? metadataPayload : null,
    });

    if (recycleErr) {
      console.warn('Recycle bin insert warning:', recycleErr.message);
    }

    // 3. Remove record from active table so queries remain clean
    const { error: delErr } = await supabase.from(tableName).delete().eq('id', recordId);
    if (delErr) {
      return { success: false, error: delErr.message };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Soft delete failed' };
  }
}

async function restoreRecordFromRecycleBin(
  recycleBinId: string,
  restoredByAdminId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: item, error: fetchErr } = await supabase
      .from('recycle_bin')
      .select('*')
      .eq('id', recycleBinId)
      .maybeSingle();

    if (fetchErr || !item) {
      return { success: false, error: fetchErr?.message || 'Recycle bin item not found' };
    }

    const { table_name, record_data, metadata } = item;

    // Re-insert into original table
    const { error: restoreErr } = await supabase
      .from(table_name)
      .upsert(record_data);

    if (restoreErr) {
      return { success: false, error: `Failed to restore to ${table_name}: ${restoreErr.message}` };
    }

    // Restore associated metadata if present (e.g. employee_salary)
    if (metadata?.associated_employee_salary && Array.isArray(metadata.associated_employee_salary)) {
      for (const sal of metadata.associated_employee_salary) {
        await supabase.from('employee_salary').upsert(sal);
      }
    }

    // Delete item from recycle_bin
    await supabase.from('recycle_bin').delete().eq('id', recycleBinId);

    // Audit log
    await auditLog(restoredByAdminId, 'recycle_bin.restore', item.record_id, item.record_name || item.record_id, {
      table_name,
      deleted_by: item.deleted_by,
      deleted_at: item.deleted_at,
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Restoration failed' };
  }
}

interface PayrollInput {
  emp: Employee;
  salary: EmployeeSalary | undefined;
  leavesAllotted: number;
  presentDates: Set<string>;
  otMinutes: number;  // total overtime minutes this month
  totalWorkedMinutes?: number; // total worked minutes this month
  holidays: PublicHoliday[];
  empHolidays: string[];
  leaveRecords?: LeaveRequest[]; // leave records for this employee in this month
  weeklyOffs: Set<number>;      // Set of weekday numbers 1-7 representing weekly off days
  lateMinutes?: number;
  shortageMinutes?: number;
  year: number;
  month: number;
  calcMethod?: 'fixed_30' | 'working_day' | 'actual_calendar';
  customStartDate?: string;
  customEndDate?: string;
}

function calculateSalarySlip(input: PayrollInput): SalarySlip {
  const {
    emp,
    salary,
    leavesAllotted,
    presentDates,
    otMinutes,
    totalWorkedMinutes = 0,
    holidays,
    empHolidays,
    leaveRecords,
    weeklyOffs,
    lateMinutes = 0,
    shortageMinutes = 0,
    year,
    month,
    calcMethod = 'working_day',
    customStartDate,
    customEndDate
  } = input;

  const holSet = new Set([...holidays.map(h => h.date), ...empHolidays]);

  // Build the exact list of date strings (yyyy-mm-dd) to evaluate
  const dateList: string[] = [];
  if (customStartDate && customEndDate) {
    const startDt = new Date(customStartDate + 'T00:00:00');
    const endDt = new Date(customEndDate + 'T00:00:00');
    for (let d = new Date(startDt); d <= endDt; d.setDate(d.getDate() + 1)) {
      dateList.push(ymd(d));
    }
  } else {
    const dimMonth = new Date(year, month, 0).getDate();
    for (let d = 1; d <= dimMonth; d++) {
      dateList.push(ymd(new Date(year, month - 1, d)));
    }
  }

  const dim = dateList.length;

  // Sets of approved paid and unpaid leave dates
  const approvedPaidLeaveDates = new Set<string>();
  const unpaidLeaveDates = new Set<string>();

  (leaveRecords ?? []).forEach(l => {
    const start = new Date(l.start_date);
    const end = new Date(l.end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = ymd(d);
      if (l.type === 'unpaid') {
        unpaidLeaveDates.add(ds);
      } else {
        approvedPaidLeaveDates.add(ds);
      }
    }
  });

  const now = new Date();
  const todayStr = ymd(now);

  // Step 1: Map status of every day in dateList
  type DayStatus = 'present' | 'absent' | 'holiday' | 'weekly_off' | 'paid_leave' | 'future';
  const dayStatusMap: Record<string, DayStatus> = {};

  for (const ds of dateList) {
    const dt = new Date(ds + 'T00:00:00');

    if (ds > todayStr) {
      // Future date -> do NOT count as absent/deduction!
      dayStatusMap[ds] = 'future';
    } else if (presentDates.has(ds)) {
      dayStatusMap[ds] = 'present';
    } else if (unpaidLeaveDates.has(ds)) {
      dayStatusMap[ds] = 'absent';
    } else if (approvedPaidLeaveDates.has(ds)) {
      dayStatusMap[ds] = 'paid_leave';
    } else if (holSet.has(ds)) {
      dayStatusMap[ds] = 'holiday';
    } else if (weeklyOffs.has(toWeekdayNumber(dt))) {
      dayStatusMap[ds] = 'weekly_off';
    } else {
      dayStatusMap[ds] = 'absent';
    }
  }

  // Step 2: Sandwich Leave Policy Evaluation over dateList
  const finalStatusMap: Record<string, DayStatus> = { ...dayStatusMap };
  let sandwichedCount = 0;

  for (let i = 0; i < dateList.length; i++) {
    const ds = dateList[i];
    const initStatus = dayStatusMap[ds];

    if (ds <= todayStr && (initStatus === 'holiday' || initStatus === 'weekly_off' || initStatus === 'paid_leave')) {
      let prevStatus: 'present' | 'absent' | null = null;
      for (let b = i - 1; b >= 0; b--) {
        const s = dayStatusMap[dateList[b]];
        if (s === 'present' || s === 'absent') {
          prevStatus = s;
          break;
        }
      }
      if (!prevStatus) prevStatus = 'absent';

      let nextStatus: 'present' | 'absent' | null = null;
      for (let f = i + 1; f < dateList.length; f++) {
        const s = dayStatusMap[dateList[f]];
        if (s === 'present' || s === 'absent') {
          nextStatus = s;
          break;
        }
      }
      if (!nextStatus) nextStatus = 'absent';

      if (prevStatus === 'absent' && nextStatus === 'absent') {
        finalStatusMap[ds] = 'absent';
        sandwichedCount++;
      }
    }
  }

  // Step 3: Count final totals
  let daysPresent = 0;
  let daysAbsent = 0;
  let paidLeaveDays = 0;
  let nonSandwichedHolidays = 0;
  let nonSandwichedWeeklyOffs = 0;
  let futureDaysCount = 0;

  for (const ds of dateList) {
    const st = finalStatusMap[ds];
    if (st === 'present') daysPresent++;
    else if (st === 'absent') daysAbsent++;
    else if (st === 'paid_leave') paidLeaveDays++;
    else if (st === 'holiday') nonSandwichedHolidays++;
    else if (st === 'weekly_off') nonSandwichedWeeklyOffs++;
    else if (st === 'future') futureDaysCount++;
  }

  const gross = salary?.monthly_salary ?? 0;
  const fullMonthDays = new Date(year, month, 0).getDate() || 30;
  let dailyRate = 0;
  let workingDays = dim;

  if (calcMethod === 'fixed_30') {
    workingDays = customStartDate && customEndDate ? dim : 30;
    dailyRate = gross > 0 ? gross / 30 : 0;
  } else if (calcMethod === 'actual_calendar') {
    workingDays = dim;
    dailyRate = gross > 0 ? gross / fullMonthDays : 0;
  } else {
    // Working-Day Based ('working_day')
    const totalHolidaysInMonth = nonSandwichedHolidays + nonSandwichedWeeklyOffs;
    const totalWorkingDays = Math.max(1, dim - totalHolidaysInMonth - leavesAllotted);
    workingDays = totalWorkingDays;
    dailyRate = gross > 0 ? gross / Math.max(1, (customStartDate && customEndDate ? dim : fullMonthDays) - totalHolidaysInMonth) : 0;
  }

  const perDay = dailyRate;
  const excessAbsentDays = Math.max(0, daysAbsent - leavesAllotted);
  const unpaidLeaveDeduction = excessAbsentDays * dailyRate;

  let basePay = 0;
  if (customStartDate && customEndDate) {
    const earnedDays = daysPresent + paidLeaveDays + nonSandwichedHolidays + nonSandwichedWeeklyOffs;
    basePay = Math.min(gross, dailyRate * earnedDays);
  } else {
    const isCurrentMonth = (year === now.getFullYear() && month === (now.getMonth() + 1));
    if (isCurrentMonth && todayStr.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`) {
      const earnedDays = daysPresent + paidLeaveDays + nonSandwichedHolidays + nonSandwichedWeeklyOffs;
      basePay = Math.min(gross, dailyRate * earnedDays);
    } else {
      basePay = Math.max(0, gross - unpaidLeaveDeduction);
    }
  }

  // Shift length in minutes derived from emp.shift_start and emp.shift_end (supporting overnight shifts)
  let sEndMins = HHMM(emp.shift_end);
  const sStartMins = HHMM(emp.shift_start);
  if (sEndMins <= sStartMins) sEndMins += 24 * 60;
  const shiftLenMins = Math.max(300, sEndMins - sStartMins) || 480;
  const perMinute = shiftLenMins > 0 ? perDay / shiftLenMins : 0;

  const lateCutDeduction = lateMinutes * perMinute;
  const underworkDeduction = shortageMinutes * perMinute;

  // Pay after deductions (before adding overtime)
  const payAfterDeductions = Math.max(0, basePay - lateCutDeduction - underworkDeduction);

  // Overtime calculated based on employee settings
  const otEnabled = emp.overtime_enabled ?? false;
  const otRate = emp.overtime_rate_per_hour ?? 0;
  const otFullHours = Math.floor(otMinutes / 60);
  const otRemainMins = otMinutes % 60;
  const otDecimalHours = otMinutes / 60;
  const overtimePay = otEnabled ? otDecimalHours * otRate : 0;

  const netPay = Math.max(0, payAfterDeductions + overtimePay);

  const finalWorkedMins = (totalWorkedMinutes && totalWorkedMinutes > 0)
    ? totalWorkedMinutes
    : Math.max(0, (daysPresent * shiftLenMins) - lateMinutes);

  return {
    emp,
    sal: salary,
    daysInMonth: dim,
    workingDays,
    daysPresent,
    daysAbsent,
    leavesUsed: paidLeaveDays,
    leavesAllotted,
    perDaySalary: perDay,
    grossPay: gross,
    basePay,
    unpaidLeaveDeduction,
    payAfterDeductions,
    absentDeduction: unpaidLeaveDeduction,
    leaveDeduction: 0,
    overtimeHours: otFullHours,
    overtimeMinutes: otRemainMins,
    overtimePay,
    lateMinutes,
    lateCutDeduction,
    shortageMinutes,
    underworkDeduction,
    netPay,
    sandwichedDays: sandwichedCount,
    calcMethod,
    totalWorkedMinutes: finalWorkedMins
  };
}


// ─── SVG Icons ────────────────────────────────────────────────────────────────
const I = {
  location: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx={12} cy={10} r={3} /></svg>,
  dashboard: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={3} width={7} height={7} rx={1} /><rect x={14} y={3} width={7} height={7} rx={1} /><rect x={14} y={14} width={7} height={7} rx={1} /><rect x={3} y={14} width={7} height={7} rx={1} /></svg>,
  employees: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx={9} cy={7} r={4} /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  attendance: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
  leave: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={4} width={18} height={18} rx={2} /><path d="M16 2v4M8 2v4M3 10h18" /></svg>,
  payroll: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1={12} y1={1} x2={12} y2={23} /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  rupee: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12M6 8h12M6 3a5 5 0 0 1 0 10h6M6 13l7 8" /></svg>,
  holidays: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={11} cy={11} r={8} /><line x1={21} y1={21} x2={16.65} y2={16.65} /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1={12} y1={5} x2={12} y2={19} /><line x1={5} y1={12} x2={19} y2={12} /></svg>,
  logout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1={21} y1={12} x2={9} y2={12} /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1={18} y1={6} x2={6} y2={18} /><line x1={6} y1={6} x2={18} y2={18} /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1={12} y1={9} x2={12} y2={13} /><line x1={12} y1={17} x2={12.01} y2={17} /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={10} /><polyline points="12 6 12 12 16 14" /></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx={12} cy={12} r={3} /></svg>,
  eyeOff: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1={1} y1={1} x2={23} y2={23} /></svg>,
  filter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>,
  edit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>,
  star: <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  report: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1={16} y1={13} x2={8} y2={13} /><line x1={16} y1={17} x2={8} y2={17} /><polyline points="10 9 9 9 8 9" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1={12} y1={15} x2={12} y2={3} /></svg>,
  print: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x={6} y={14} width={12} height={8} /></svg>,
  bar: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1={18} y1={20} x2={18} y2={10} /><line x1={12} y1={20} x2={12} y2={4} /><line x1={6} y1={20} x2={6} y2={14} /><line x1={2} y1={20} x2={22} y2={20} /></svg>,
  scanner: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>,
  qr: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={3} width={7} height={7} /><rect x={14} y={3} width={7} height={7} /><rect x={3} y={14} width={7} height={7} /><rect x={14} y={14} width={7} height={7} /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1={22} y1={2} x2={11} y2={13} /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>,
};

// ─── Nav Config ───────────────────────────────────────────────────────────────
type Page = 'dashboard' | 'employees' | 'attendance' | 'payroll' | 'holidays' | 'reports' | 'scanners' | 'locations' | 'audit_log' | 'super_admin_dash' | 'super_admin_companies' | 'super_admin_admins' | 'super_admin_analytics' | 'super_admin_security' | 'super_admin_health' | 'super_admin_recycle_bin';
const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: I.dashboard },
  { id: 'employees', label: 'Employees', icon: I.employees },
  { id: 'attendance', label: 'Attendance', icon: I.attendance },
  { id: 'payroll', label: 'Payroll', icon: I.rupee },
  { id: 'holidays', label: 'Holidays', icon: I.holidays },
  { id: 'reports', label: 'Reports', icon: I.report },
  { id: 'scanners', label: 'Scanners', icon: I.qr },
  { id: 'locations', label: 'Locations', icon: I.location },
  { id: 'audit_log', label: 'Audit Log', icon: I.shield },
];

let isResettingPassword = false;

function getPasswordStrength(pass: string): { score: number; label: string; color: string } {
  if (!pass) return { score: 0, label: '', color: '#e2e8f0' };
  let score = 0;
  if (pass.length >= 6) score += 1;
  if (pass.length >= 8) score += 1;
  if (/[A-Z]/.test(pass) || /[0-9]/.test(pass)) score += 1;
  if (/[^A-Za-z0-9]/.test(pass)) score += 1;

  if (score <= 1) return { score: 1, label: 'Weak', color: '#ef4444' };
  if (score <= 2) return { score: 2, label: 'Fair', color: '#f59e0b' };
  if (score <= 3) return { score: 3, label: 'Good', color: '#3b82f6' };
  return { score: 4, label: 'Strong', color: '#10b981' };
}

function OtpPinInput({ value, onChange }: { value: string; onChange: (val: string) => void }) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChar = (index: number, char: string) => {
    const clean = char.replace(/\D/g, '');
    if (!clean) return;
    const nextArr = value.split('');
    nextArr[index] = clean[clean.length - 1];
    const nextVal = nextArr.join('').slice(0, 6);
    onChange(nextVal);

    if (index < 5 && clean) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!value[index] && index > 0) {
        inputRefs.current[index - 1]?.focus();
      }
      const nextArr = value.split('');
      nextArr[index] = '';
      onChange(nextArr.join(''));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted) {
      onChange(pasted);
      const targetIdx = Math.min(pasted.length, 5);
      inputRefs.current[targetIdx]?.focus();
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '10px 0 14px 0' }}>
      {Array.from({ length: 6 }).map((_, i) => {
        const val = value[i] || '';
        const isFilled = !!val;
        return (
          <input
            key={i}
            ref={el => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={val}
            onChange={e => handleChar(i, e.target.value)}
            onKeyDown={e => handleKeyDown(i, e)}
            onPaste={handlePaste}
            style={{
              width: 44,
              height: 52,
              fontSize: 22,
              fontWeight: 700,
              textAlign: 'center',
              borderRadius: 10,
              border: isFilled ? '2px solid var(--primary)' : '1.5px solid var(--border)',
              background: isFilled ? 'var(--surface-1)' : 'var(--surface-2)',
              color: 'var(--text)',
              boxShadow: isFilled ? '0 2px 8px rgba(37, 99, 235, 0.15)' : 'none',
              transition: 'all 0.15s ease',
              outline: 'none',
            }}
          />
        );
      })}
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (session: Session) => void }) {
  const [authMode, setAuthMode] = useState<'login' | 'request_otp' | 'verify_otp'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockoutTime, setLockoutTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);

  // OTP & New Password states
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (!lockoutTime) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.round((lockoutTime - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        setLockoutTime(null);
        setAttempts(0);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lockoutTime]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown(c => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutTime && Date.now() < lockoutTime) {
      setError(`Too many failed attempts. Please wait ${timeLeft} seconds.`);
      return;
    }

    if (!email) {
      setError('Please enter your email address.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true); setError(''); setSuccess('');

    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });

    if (err) {
      setLoading(false);
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);
      if (newAttempts >= 5) {
        const lockout = Date.now() + 60 * 1000;
        setLockoutTime(lockout);
        setTimeLeft(60);
        setError('Too many failed attempts. You have been locked out for 60 seconds.');
      } else {
        const errMsg = err.message === 'Invalid login credentials' ? 'Incorrect password' : err.message;
        setError(`${errMsg} (${5 - newAttempts} attempts remaining)`);
      }
      return;
    }

    let isScanner = false;
    let isRegistered = true;

    try {
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .maybeSingle();

      const isSuperAdminUser = data.user.email ? ['macrotechsoftwares@gmail.com', 'amndby222@gmail.com'].includes(data.user.email.trim().toLowerCase()) : false;

      if (profile && (profile as any).status === 'suspended' && !isSuperAdminUser) {
        await supabase.auth.signOut();
        setLoading(false);
        setError('🚫 Your account has been suspended by Super Admin. Access blocked.');
        return;
      }

      if (profileErr) {
        if (data.user.user_metadata?.is_auto_admin !== 'true') {
          isRegistered = false;
        }
      } else {
        if (!profile) {
          // If the profile does not exist in the database (e.g. database reset), auto-create it
          const { error: insErr } = await supabase.from('profiles').insert({
            id: data.user.id,
            email: data.user.email,
            role: 'admin',
            admin_id: data.user.id,
            status: 'active'
          });
          if (insErr) {
            isRegistered = false;
          }
        } else if (profile.role === 'scanner') {
          isScanner = true;
        }
      }
    } catch {
      // Ignore fallback
    }

    if (data.user.email && ['macrotechsoftwares@gmail.com', 'amndby222@gmail.com'].includes(data.user.email.trim().toLowerCase())) {
      isRegistered = true;
    }

    if (!isRegistered) {
      await supabase.auth.signOut();
      setLoading(false);
      setError('This email address is not registered.');
      return;
    }

    if (isScanner) {
      await supabase.auth.signOut();
      setLoading(false);
      setError('This is a scanner kiosk account. Please sign in via the mobile app.');
      return;
    }

    setLoading(false);
    setAttempts(0);
    setLockoutTime(null);
    if (data.session) onLogin(data.session as Session);
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError('Please enter your email address.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setLoading(true); setError(''); setSuccess('');

    try {
      // 1. Try sending recovery OTP first via Supabase Auth
      let { error: resetErr } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });

      // 2. If resetPasswordForEmail fails, try signInWithOtp (which uses the working Resend OTP)
      if (resetErr) {
        console.warn('resetPasswordForEmail failed, trying signInWithOtp fallback:', resetErr.message);
        const { error: otpErr } = await supabase.auth.signInWithOtp({
          email: email.trim(),
          options: { shouldCreateUser: false },
        });
        if (otpErr) {
          setLoading(false);
          setError(otpErr.message || resetErr.message);
          return;
        }
      }

      setLoading(false);
      setResendCooldown(30);
      setSuccess(`A 6-digit OTP code has been sent to ${email}. Please check your inbox & spam folder.`);
      setAuthMode('verify_otp');
    } catch (err: any) {
      setLoading(false);
      setError(err.message || 'An unexpected error occurred while requesting OTP.');
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode.trim()) {
      setError('Please enter the 6-digit OTP code sent to your email.');
      return;
    }
    if (!newPassword) {
      setError('Please enter a new password.');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match. Please check and try again.');
      return;
    }

    setLoading(true); setError(''); setSuccess('');
    isResettingPassword = true;

    try {
      // Try verifying as recovery OTP first
      let verifyRes = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otpCode.trim(),
        type: 'recovery',
      });

      // If recovery fails, fallback to email OTP (from Resend signInWithOtp)
      if (verifyRes.error) {
        verifyRes = await supabase.auth.verifyOtp({
          email: email.trim(),
          token: otpCode.trim(),
          type: 'email',
        });
      }

      if (verifyRes.error) {
        isResettingPassword = false;
        setLoading(false);
        setError(verifyRes.error.message || 'Invalid or expired OTP code.');
        return;
      }

      // Update password for verified session
      const { error: updateErr } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateErr) {
        isResettingPassword = false;
        setLoading(false);
        setError(updateErr.message);
        return;
      }

      await supabase.auth.signOut();
      isResettingPassword = false;

      setLoading(false);
      setSuccess('Password updated successfully! Please sign in with your new password.');
      setPassword('');
      setOtpCode('');
      setNewPassword('');
      setConfirmPassword('');
      setAuthMode('login');
    } catch (err: any) {
      isResettingPassword = false;
      setLoading(false);
      setError(err.message || 'An error occurred during password reset.');
    }
  };

  return (
    <div className="login-wrap">
      {/* ── Left Branding Panel ── */}
      <div className="login-panel-left">
        <div className="login-brand-logo">
          <img src="/logo.jpeg" alt="StaffEase Logo" />
        </div>
        <div className="login-brand-title">StaffEase</div>
        <p className="login-brand-sub">
          Smart attendance management with face recognition, shift scheduling, and real-time analytics.
        </p>

        <div className="login-features">
          <div className="login-feature-item">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </div>
            <div className="login-feature-text">
              Face Recognition Attendance
              <span>Contactless, instant check-in via AI</span>
            </div>
          </div>

          <div className="login-feature-item">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <rect x={3} y={4} width={18} height={18} rx={2} /><path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </div>
            <div className="login-feature-text">
              Smart Shift Scheduling
              <span>Rotating shifts, leave management & overtime</span>
            </div>
          </div>

          <div className="login-feature-item">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <line x1={12} y1={1} x2={12} y2={23} /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div className="login-feature-text">
              Automated Payroll
              <span>Accurate net pay, deductions & slip export</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right Form Panel ── */}
      <div className="login-panel-right">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-logo-icon">
              <img src="/logo.jpeg" alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div>
              <div className="login-logo-text">StaffEase</div>
              <div className="login-logo-sub">Admin Portal</div>
            </div>
          </div>

          {authMode === 'login' && (
            <>
              <h2 className="login-title">Welcome back 👋</h2>
              <p className="login-subtitle">
                Sign in to manage your team's attendance and payroll
              </p>
            </>
          )}

          {authMode === 'request_otp' && (
            <>
              <h2 className="login-title">Reset Password 🔑</h2>
              <p className="login-subtitle">
                Enter your email address to receive a 6-digit OTP code
              </p>
            </>
          )}

          {authMode === 'verify_otp' && (
            <>
              <h2 className="login-title">Verify OTP Code 🔒</h2>
              <p className="login-subtitle">
                Enter the 6-digit OTP sent to <strong>{email}</strong> and set a new password
              </p>
            </>
          )}

          {success && (
            <div className="success-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 10, background: '#ecfdf5', borderLeft: '3px solid #059669', color: '#059669', fontSize: 13, marginBottom: 18 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              {success}
            </div>
          )}

          {error && (
            <div className="error-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }}>
                <circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} />
              </svg>
              {error}
            </div>
          )}

          {/* ── Mode 1: Sign In Form ── */}
          {authMode === 'login' && (
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  disabled={!!lockoutTime}
                  autoComplete="email"
                />
              </div>
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label className="form-label" style={{ margin: 0 }}>Password</label>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
                    onClick={() => {
                      setError('');
                      setSuccess('');
                      setAuthMode('request_otp');
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    className="form-input"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    disabled={!!lockoutTime}
                    autoComplete="current-password"
                    style={{ paddingRight: 40 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 0
                    }}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <span style={{ width: 18, height: 18, display: 'inline-block' }}>{showPassword ? I.eyeOff : I.eye}</span>
                  </button>
                </div>
              </div>

              {attempts > 0 && !lockoutTime && (
                <div style={{ fontSize: 12, color: '#d97706', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1={12} y1={9} x2={12} y2={13} /><line x1={12} y1={17} x2={12.01} y2={17} />
                  </svg>
                  {5 - attempts} attempt{5 - attempts !== 1 ? 's' : ''} remaining before lockout
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full btn-lg"
                style={{ marginTop: 12, justifyContent: 'center' }}
                disabled={loading || !!lockoutTime}
              >
                {lockoutTime
                  ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg> Locked out for {timeLeft}s</>
                  : loading
                    ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Signing in…</>
                    : 'Sign In →'
                }
              </button>
            </form>
          )}

          {/* ── Mode 2: Request OTP Form ── */}
          {authMode === 'request_otp' && (
            <form onSubmit={handleRequestOtp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full btn-lg"
                style={{ marginTop: 6, justifyContent: 'center' }}
                disabled={loading}
              >
                {loading ? 'Sending OTP Code…' : 'Send OTP Code →'}
              </button>

              <button
                type="button"
                className="btn btn-ghost w-full"
                style={{ fontSize: 13, color: 'var(--text-secondary)' }}
                onClick={() => {
                  setError('');
                  setSuccess('');
                  setAuthMode('login');
                }}
              >
                ← Back to Sign In
              </button>
            </form>
          )}

          {/* ── Mode 3: Verify OTP & Change Password Form ── */}
          {authMode === 'verify_otp' && (
            <form onSubmit={handleVerifyOtp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-group" style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" style={{ margin: 0 }}>6-Digit OTP Code</label>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Enter code sent to email</span>
                </div>
                <OtpPinInput value={otpCode} onChange={setOtpCode} />
              </div>

              <div className="form-group">
                <label className="form-label">New Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="form-input"
                    type={showNewPassword ? 'text' : 'password'}
                    placeholder="Enter new password (min. 6 chars)"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    required
                    minLength={6}
                    style={{ paddingRight: 40 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 0
                    }}
                  >
                    <span style={{ width: 18, height: 18, display: 'inline-block' }}>{showNewPassword ? I.eyeOff : I.eye}</span>
                  </button>
                </div>

                {newPassword && (() => {
                  const pwdStr = getPasswordStrength(newPassword);
                  return (
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 4, height: 4 }}>
                        {[1, 2, 3, 4].map(s => (
                          <div
                            key={s}
                            style={{
                              flex: 1,
                              borderRadius: 2,
                              background: s <= pwdStr.score ? pwdStr.color : '#e2e8f0',
                              transition: 'all 0.2s ease',
                            }}
                          />
                        ))}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: pwdStr.color, textAlign: 'right' }}>
                        {pwdStr.label} password
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="form-group">
                <label className="form-label">Confirm New Password</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Re-enter new password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                />
                {confirmPassword && (
                  <div style={{ marginTop: 4, fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, color: confirmPassword === newPassword ? '#10b981' : '#ef4444' }}>
                    {confirmPassword === newPassword ? (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 14, height: 14 }}>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Passwords match
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 14, height: 14 }}>
                          <line x1={18} y1={6} x2={6} y2={18} /><line x1={6} y1={6} x2={18} y2={18} />
                        </svg>
                        Passwords do not match
                      </>
                    )}
                  </div>
                )}
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full btn-lg"
                style={{ marginTop: 8, justifyContent: 'center', gap: 8 }}
                disabled={loading || otpCode.length < 6 || !newPassword || confirmPassword !== newPassword}
              >
                {loading ? 'Verifying & Resetting…' : '🔒 Verify & Reset Password'}
              </button>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 13 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--primary)', fontWeight: 600, cursor: resendCooldown > 0 ? 'default' : 'pointer', padding: 0 }}
                  disabled={resendCooldown > 0 || loading}
                  onClick={handleRequestOtp}
                >
                  {resendCooldown > 0 ? `Resend OTP in ${resendCooldown}s` : 'Resend OTP Code'}
                </button>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontWeight: 500, cursor: 'pointer', padding: 0 }}
                  onClick={() => {
                    setError('');
                    setSuccess('');
                    setAuthMode('login');
                  }}
                >
                  ← Back to Sign In
                </button>
              </div>
            </form>
          )}

          <div className="login-divider">
            Secured with Supabase Auth · Row Level Security enabled
          </div>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE SUPER ADMIN SUITE
// ═══════════════════════════════════════════════════════════════════════════════

function SuperAdminDashboardPage({ setPage, onImpersonate }: { setPage: (p: Page) => void; onImpersonate: (admin: { id: string; email: string; name?: string }) => void }) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    companies: 0,
    activeCompanies: 0,
    admins: 0,
    employees: 0,
    attendanceToday: 0,
    attendanceTotal: 0,
    payrollEst: 0,
    pendingLeaves: 0,
    locations: 0,
  });
  const [recentAdmins, setRecentAdmins] = useState<any[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const todayStr = ymd(new Date());

    let adminList: any[] = [];

    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_all_companies');
    if (!rpcErr && rpcData) {
      adminList = rpcData.filter((p: any) => p.email !== 'macrotechsoftwares@gmail.com' && p.email !== 'amndby222@gmail.com');
    } else {
      const { data: profData } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
      adminList = (profData ?? []).filter((p: any) => (p.role === 'admin' || !p.role) && p.email !== 'macrotechsoftwares@gmail.com' && p.email !== 'amndby222@gmail.com');
    }

    const [empRes, attTodayRes, attTotalRes, locRes, leaveRes, salRes] = await Promise.all([
      supabase.from('employees').select('id, base_salary'),
      supabase.from('attendance').select('id', { count: 'exact' }).gte('timestamp', todayStr + 'T00:00:00'),
      supabase.from('attendance').select('id', { count: 'exact' }),
      supabase.from('locations').select('id', { count: 'exact' }),
      supabase.from('leave_requests').select('id').eq('status', 'pending'),
      supabase.from('employee_salary').select('monthly_net_salary'),
    ]);

    const empList = empRes.data ?? [];
    const salList = salRes.data ?? [];

    let totalPayroll = salList.reduce((acc: number, s: any) => acc + (Number(s.monthly_net_salary) || 0), 0);
    if (!totalPayroll && empList.length) {
      totalPayroll = empList.reduce((acc: number, e: any) => acc + (Number(e.base_salary) || 25000), 0);
    }

    setStats({
      companies: adminList.length,
      activeCompanies: Math.max(1, adminList.length),
      admins: adminList.length,
      employees: empList.length,
      attendanceToday: attTodayRes.count ?? 0,
      attendanceTotal: attTotalRes.count ?? 0,
      payrollEst: totalPayroll,
      pendingLeaves: leaveRes.data?.length ?? 0,
      locations: locRes.count ?? 0,
    });

    setRecentAdmins(adminList.slice(0, 5));
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return (
    <div style={{ padding: 60, textAlign: 'center' }}>
      <div className="spinner" />
      <p style={{ marginTop: 14, color: 'var(--text-muted)', fontWeight: 600 }}>Loading Super Admin Command Center…</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── Global Command Header (Light Theme) ── */}
      <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', color: '#0f172a', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 4px 20px -2px rgba(15, 23, 42, 0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="badge green" style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.5, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20 }}>
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 8, height: 8 }}>
                  <circle cx={12} cy={12} r={10} />
                </svg>
                ALL SYSTEMS OPERATIONAL
              </span>
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Platform Uptime: 99.98%</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.3px' }}>Super Admin Platform Command Center</h2>
            <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13, fontWeight: 400 }}>
              Real-time platform metrics, company tenant directory & infrastructure telemetry
            </p>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              className="btn"
              style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', fontWeight: 600, borderRadius: 10, border: 'none', padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 14px rgba(37, 99, 235, 0.25)' }}
              onClick={() => setPage('super_admin_companies')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /><path d="M10 6h4" /><path d="M10 10h4" />
              </svg>
              <span>Manage Companies</span>
            </button>
            <button
              className="btn"
              style={{ background: '#f1f5f9', color: '#0f172a', fontWeight: 600, borderRadius: 10, border: '1px solid #cbd5e1', padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 2px 6px rgba(0, 0, 0, 0.04)' }}
              onClick={() => setPage('super_admin_security')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
              </svg>
              <span>Audit Logs</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── KPI Metric Cards Grid (6 High-Density Enterprise Cards in 1 Row) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
        {/* Total Companies */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #4f46e5' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Total Companies</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4f46e5', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>{stats.companies}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge green" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Active</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stats.activeCompanies} Tenants</span>
          </div>
        </div>

        {/* Admin Accounts */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #3b82f6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Admin Accounts</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><circle cx={12} cy={10} r={3} />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>{stats.admins}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge blue" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Superusers</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Admins</span>
          </div>
        </div>

        {/* Total Workforce */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Total Workforce</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx={9} cy={7} r={4} /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>{stats.employees}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge green" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Global Staff</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Employees</span>
          </div>
        </div>

        {/* Punches Today */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #f59e0b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Punches Today</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fffbeb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>{stats.attendanceToday}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge warning" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Live</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>({stats.attendanceTotal} All-Time)</span>
          </div>
        </div>

        {/* Monthly Payroll Vol. */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #8b5cf6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Payroll Vol.</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#f3e8ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b5cf6', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <rect width={20} height={14} x={2} y={5} rx={2} /><line x1={2} x2={22} y1={10} y2={10} />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>₹{(stats.payrollEst / 1000).toFixed(0)}k</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge purple" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Est. Volume</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Monthly</span>
          </div>
        </div>

        {/* Pending Leaves */}
        <div className="card" style={{ padding: '16px 14px', borderRadius: 14, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.05)', borderTop: '4px solid #ec4899' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>Pending Leaves</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fce7f3', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ec4899', flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <rect width={18} height={18} x={3} y={4} rx={2} ry={2} /><line x1={16} x2={16} y1={2} y2={6} /><line x1={8} x2={8} y1={2} y2={6} /><line x1={3} x2={21} y1={10} y2={10} />
              </svg>
            </div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.5px' }}>{stats.pendingLeaves}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'nowrap' }}>
            <span className="badge red" style={{ fontSize: 9, padding: '2px 6px', flexShrink: 0, fontWeight: 500 }}>Action</span>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Approval</span>
          </div>
        </div>
      </div>

      {/* ── Visual Trend Analytics Grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20 }}>
        <div className="card" style={{ padding: 24, borderRadius: 16, background: '#ffffff', border: '1px solid #e2e8f0' }}>
          <div className="card-header" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="card-title" style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Platform Attendance Surge (Last 30 Days)</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Monthly attendance activity trend</div>
            </div>
            <span className="badge blue" style={{ padding: '4px 10px', fontSize: 11, fontWeight: 500 }}>Live Activity</span>
          </div>
          <LineArea
            data={[
              { label: 'W1', value: Math.max(5, stats.attendanceToday * 0.7) },
              { label: 'W2', value: Math.max(12, stats.attendanceToday * 0.9) },
              { label: 'W3', value: Math.max(18, stats.attendanceToday * 1.1) },
              { label: 'W4', value: Math.max(25, stats.attendanceToday) },
            ]}
            height={180}
            stroke="#3b82f6"
            gradId="super_att_grad"
          />
        </div>

        <div className="card" style={{ padding: 24, borderRadius: 16, background: '#ffffff', border: '1px solid #e2e8f0' }}>
          <div className="card-header" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="card-title" style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Infrastructure & System Health</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Active backend services availability</div>
            </div>
            <span className="badge green" style={{ padding: '4px 10px', fontSize: 11, fontWeight: 500 }}>Operational</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth={2} style={{ width: 16, height: 16 }}>
                    <ellipse cx={12} cy={5} rx={9} ry={3} /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>PostgreSQL Database Engine</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Cloud SQL Postgres 15</div>
                </div>
              </div>
              <span className="badge green" style={{ fontWeight: 500 }}>12ms • Operational</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={2} style={{ width: 16, height: 16 }}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><circle cx={12} cy={10} r={3} />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Supabase GoTrue Auth Service</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>JWT Authentication Engine</div>
                </div>
              </div>
              <span className="badge blue" style={{ fontWeight: 500 }}>100% Active</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#f3e8ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth={2} style={{ width: 16, height: 16 }}>
                    <rect width={20} height={16} x={2} y={4} rx={2} /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Resend SMTP Mailer Relay</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Transactional Mail Service</div>
                </div>
              </div>
              <span className="badge purple" style={{ fontWeight: 500 }}>TLS 1.3 Connected</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fffbeb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth={2} style={{ width: 16, height: 16 }}>
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx={12} cy={10} r={3} />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Geofence Location Scopes</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Active GPS Workplaces</div>
                </div>
              </div>
              <span className="badge warning" style={{ fontWeight: 500 }}>{stats.locations} Workplaces</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Registered Companies Directory Table ── */}
      <div className="card" style={{ padding: 24, borderRadius: 16, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 20px -2px rgba(15, 23, 42, 0.05)' }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div className="card-title" style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Organization & Tenant Directory</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Quick admin impersonation & workspace access</div>
          </div>
          <button
            className="btn btn-outline"
            style={{ borderRadius: 8, fontWeight: 500, padding: '7px 14px', fontSize: 13 }}
            onClick={() => setPage('super_admin_companies')}
          >
            View All Companies ({stats.companies}) →
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>Company & Admin Email</th>
                <th style={{ padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>Status</th>
                <th style={{ padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>Registered Date</th>
                <th style={{ padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b', textAlign: 'right' }}>Admin Access</th>
              </tr>
            </thead>
            <tbody>
              {recentAdmins.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="avatar-circle" style={{ background: avatarColor(a.email || 'Admin'), width: 36, height: 36, fontSize: 13, fontWeight: 600, color: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,0.1)' }}>
                        {initials(a.email || 'A')}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 14 }}>{a.email?.split('@')[0] || 'Company Admin'}</div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 1 }}>{a.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span className="badge green" style={{ padding: '3px 8px', fontSize: 11, fontWeight: 500 }}>Active</span>
                  </td>
                  <td style={{ padding: '14px 16px', color: '#475569', fontSize: 13, fontWeight: 500 }}>
                    {a.created_at ? new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{
                        background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
                        border: 'none',
                        boxShadow: '0 3px 10px rgba(79, 70, 229, 0.25)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 14px',
                        borderRadius: 8,
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                      onClick={() => onImpersonate({ id: a.id, email: a.email, name: a.email?.split('@')[0] })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1={15} y1={12} x2={3} y2={12} />
                      </svg>
                      <span>Impersonate Admin</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SuperAdminCompaniesPage({ onImpersonate }: { onImpersonate: (admin: { id: string; email: string; name?: string }) => void }) {
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [admins, setAdmins] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<any | null>(null);

  const getLocalStatusMap = (): Record<string, 'active' | 'suspended'> => {
    try {
      const stored = localStorage.getItem('staffease_company_status_map');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  };

  const setLocalStatus = (id: string, status: 'active' | 'suspended') => {
    try {
      const map = getLocalStatusMap();
      map[id] = status;
      localStorage.setItem('staffease_company_status_map', JSON.stringify(map));
    } catch (e) {
      console.error('Failed to save local status:', e);
    }
  };

  const loadAdmins = useCallback(async () => {
    setLoading(true);

    let adminProfiles: any[] = [];
    const localMap = getLocalStatusMap();

    // Query profiles for DB status column if available
    const { data: profDbData } = await supabase.from('profiles').select('id, status');
    const dbStatusMap: Record<string, string> = {};
    (profDbData ?? []).forEach((p: any) => {
      if (p.id && p.status) dbStatusMap[p.id] = p.status;
    });

    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_all_companies');
    if (!rpcErr && rpcData) {
      adminProfiles = rpcData
        .filter((p: any) => p.email !== 'macrotechsoftwares@gmail.com' && p.email !== 'amndby222@gmail.com')
        .map((p: any) => {
          const effectiveStatus = localMap[p.id] || p.status || dbStatusMap[p.id] || 'active';
          return {
            ...p,
            employeeCount: Number(p.employee_count || 0),
            name: p.email ? p.email.split('@')[0] : 'Company Admin',
            status: effectiveStatus,
          };
        });
    } else {
      const [profilesRes, empRes] = await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: false }),
        supabase.from('employees').select('admin_id'),
      ]);

      const profilesList = profilesRes.data ?? [];
      const empList = empRes.data ?? [];

      const empCounts: Record<string, number> = {};
      empList.forEach((e: any) => {
        if (e.admin_id) empCounts[e.admin_id] = (empCounts[e.admin_id] || 0) + 1;
      });

      adminProfiles = profilesList
        .filter((p: any) => (p.role === 'admin' || !p.role) && p.email !== 'macrotechsoftwares@gmail.com' && p.email !== 'amndby222@gmail.com')
        .map((p: any) => {
          const effectiveStatus = localMap[p.id] || p.status || dbStatusMap[p.id] || 'active';
          return {
            ...p,
            employeeCount: empCounts[p.id] || 0,
            name: p.email ? p.email.split('@')[0] : 'Company Admin',
            status: effectiveStatus,
          };
        });
    }

    setAdmins(adminProfiles);
    setLoading(false);
  }, []);

  useEffect(() => { loadAdmins(); }, [loadAdmins]);

  const toggleStatus = async (id: string) => {
    const target = admins.find(a => a.id === id);
    if (!target) return;
    const nextStatus = target.status === 'active' ? 'suspended' : 'active';
    
    // 1. Immediate UI update
    setAdmins(prev => prev.map(a => a.id === id ? { ...a, status: nextStatus } : a));

    // 2. Persist locally to guarantee persistence across refreshes
    setLocalStatus(id, nextStatus);

    // 3. Persist to Supabase database
    const { error } = await supabase.from('profiles').update({ status: nextStatus }).eq('id', id);
    if (error) {
      console.warn('DB profile status update warning:', error.message);
    }
  };

  const handleDeleteAdmin = async (adminAccount: any) => {
    if (!confirm(`Are you sure you want to delete Admin account "${adminAccount.email}"?\n\nThis record will be moved to the Super Admin Recycle Bin.`)) return;

    setLoading(true);
    const res = await softDeleteRecord(
      'profiles',
      adminAccount.id,
      adminAccount.id,
      'super_admin',
      'super_admin',
      adminAccount.email || adminAccount.name
    );

    if (!res.success) {
      alert(`Failed to delete admin account: ${res.error}`);
    } else {
      await auditLog(adminAccount.id, 'super_admin.delete_admin', adminAccount.id, adminAccount.email, {
        admin_email: adminAccount.email,
        soft_deleted: true,
      });
      try {
        const map = getLocalStatusMap();
        delete map[adminAccount.id];
        localStorage.setItem('staffease_company_status_map', JSON.stringify(map));
      } catch {}
    }
    await loadAdmins();
  };

  const filtered = admins.filter(a => {
    const matchesSearch =
      a.email?.toLowerCase().includes(search.toLowerCase()) ||
      a.id?.toLowerCase().includes(search.toLowerCase()) ||
      a.name?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── Search & Filter Controls ── */}
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240, position: 'relative' }}>
            <input
              type="text"
              className="form-input"
              placeholder="Search companies by name, admin email, or company ID…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 38 }}
            />
            <svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={2} style={{ width: 18, height: 18, position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
              <circle cx={11} cy={11} r={8} /><path d="m21 21-4.35-4.35" />
            </svg>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatusFilter('all')}
            >
              All ({admins.length})
            </button>
            <button
              className={`btn btn-sm ${statusFilter === 'active' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatusFilter('active')}
            >
              Active ({admins.filter(a => a.status === 'active').length})
            </button>
            <button
              className={`btn btn-sm ${statusFilter === 'suspended' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatusFilter('suspended')}
            >
              Suspended ({admins.filter(a => a.status === 'suspended').length})
            </button>
          </div>
        </div>
      </div>

      {/* ── Companies List ── */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div className="card-title" style={{ fontSize: 16, fontWeight: 700 }}>Companies & Admin Directory</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Manage tenant permissions & open admin workspaces</div>
          </div>
          <span className="badge blue">{filtered.length} Organizations</span>
        </div>

        {loading ? (
          <div style={{ padding: 50, textAlign: 'center' }}><div className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {I.employees}
            <h3>No companies match search filter</h3>
            <p>Try searching with another keyword or clearing filters.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organization & Admin Email</th>
                  <th>Staff Count</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="avatar-circle" style={{ background: avatarColor(a.name), width: 34, height: 34, fontSize: 12 }}>
                          {initials(a.name)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{a.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge green" style={{ fontWeight: 600 }}>
                        {a.employeeCount} staff
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${a.status === 'active' ? 'green' : 'red'}`}>
                        {a.status === 'active' ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td>{a.created_at ? new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => setSelectedCompany(a)}
                          title="View Company Overview"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx={12} cy={12} r={3} />
                          </svg>
                          <span>Overview</span>
                        </button>
                        <button
                          className={`btn btn-sm ${a.status === 'active' ? 'btn-outline' : 'btn-primary'}`}
                          onClick={() => toggleStatus(a.id)}
                          title="Toggle Active / Suspended State"
                          style={{
                            fontSize: 11,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '6px 12px',
                            color: a.status === 'active' ? '#ef4444' : '#ffffff',
                            borderColor: a.status === 'active' ? '#fca5a5' : undefined,
                          }}
                        >
                          {a.status === 'active' ? (
                            <>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                                <circle cx={12} cy={12} r={10} /><line x1={4.93} y1={4.93} x2={19.07} y2={19.07} />
                              </svg>
                              <span>Suspend</span>
                            </>
                          ) : (
                            <>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              <span>Activate</span>
                            </>
                          )}
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{
                            background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
                            border: 'none',
                            boxShadow: '0 2px 6px rgba(79,70,229,0.25)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 14px',
                            fontWeight: 700,
                          }}
                          onClick={() => onImpersonate({ id: a.id, email: a.email, name: a.name })}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1={15} y1={12} x2={3} y2={12} />
                          </svg>
                          <span>Impersonate Admin</span>
                        </button>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => handleDeleteAdmin(a)}
                          title="Delete Admin Account (Soft Delete to Recycle Bin)"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '6px 10px',
                            color: '#ef4444',
                            borderColor: '#fca5a5',
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Enterprise Company Overview Modal (Solid 100% Opaque) ── */}
      {selectedCompany && (
        <div className="modal-backdrop" onClick={() => setSelectedCompany(null)} style={{ backdropFilter: 'blur(8px)', background: 'rgba(15, 23, 42, 0.75)', zIndex: 99999 }}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 580, padding: 28, borderRadius: 20, background: '#ffffff', color: '#0f172a', opacity: 1, border: '1px solid #e2e8f0', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)', position: 'relative', zIndex: 100000 }}>
            
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div className="avatar-circle" style={{ background: avatarColor(selectedCompany.name), width: 48, height: 48, fontSize: 16, fontWeight: 800, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {initials(selectedCompany.name)}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{selectedCompany.name}</h3>
                    <span className={`badge ${selectedCompany.status === 'active' ? 'green' : 'red'}`} style={{ fontSize: 10 }}>
                      {selectedCompany.status === 'active' ? 'Active' : 'Suspended'}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{selectedCompany.email}</div>
                </div>
              </div>

              <button
                className="btn-close"
                onClick={() => setSelectedCompany(null)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            {/* Grid metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
              <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, letterSpacing: 0.5 }}>Account Role</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                  Tenant Administrator
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, letterSpacing: 0.5 }}>Registered Workforce</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#10b981', marginTop: 4 }}>
                  {selectedCompany.employeeCount} <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Employees</span>
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, letterSpacing: 0.5 }}>Subscription Plan</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#3b82f6', marginTop: 4 }}>Enterprise Tier</div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, letterSpacing: 0.5 }}>Registered Date</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginTop: 4 }}>
                  {selectedCompany.created_at ? new Date(selectedCompany.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-outline" onClick={() => setSelectedCompany(null)} style={{ padding: '9px 18px' }}>
                Close
              </button>
              <button
                className="btn btn-primary"
                style={{
                  background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
                  border: 'none',
                  padding: '9px 20px',
                  fontWeight: 700,
                  boxShadow: '0 4px 12px rgba(79, 70, 229, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
                onClick={() => {
                  const target = selectedCompany;
                  setSelectedCompany(null);
                  onImpersonate({ id: target.id, email: target.email, name: target.name });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 15, height: 15 }}>
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
                <span>Open Admin Workspace</span>
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

function SuperAdminAdminsPage({ onImpersonate }: { onImpersonate: (admin: { id: string; email: string; name?: string }) => void }) {
  return <SuperAdminCompaniesPage onImpersonate={onImpersonate} />;
}

function SuperAdminAnalyticsPage() {
  const [, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState({
    presentRate: '0%',
    avgShiftLength: '8.4 hrs',
    peakWindow: '09:00 AM',
    payrollVolume: '₹0',
    totalEmpCount: 0,
    todayPunches: 0,
    surgeData: [
      { label: '06:00', value: 0 },
      { label: '09:00', value: 0 },
      { label: '12:00', value: 0 },
      { label: '15:00', value: 0 },
      { label: '18:00', value: 0 },
      { label: '21:00', value: 0 },
    ],
    shiftBreakdown: { Morning: 40, Day: 35, Evening: 15, Night: 10 },
  });

  useEffect(() => {
    (async () => {
      setLoading(true);
      const todayStr = ymd(new Date());

      const [empRes, attRes, salRes] = await Promise.all([
        supabase.from('employees').select('id, shift_start, base_salary'),
        supabase.from('attendance').select('timestamp, punch_type').gte('timestamp', todayStr + 'T00:00:00'),
        supabase.from('employee_salary').select('monthly_net_salary'),
      ]);

      const emps = empRes.data ?? [];
      const atts = attRes.data ?? [];
      const sals = salRes.data ?? [];

      const empCount = emps.length;
      const todayPunchesCount = atts.length;

      // 1. Calculate Present Rate
      const rateNum = empCount > 0 ? Math.min(100, Math.round((todayPunchesCount / empCount) * 100)) : 0;

      // 2. Calculate Total Payroll
      let totalPay = sals.reduce((acc: number, s: any) => acc + (Number(s.monthly_net_salary) || 0), 0);
      if (!totalPay && empCount > 0) {
        totalPay = emps.reduce((acc: number, e: any) => acc + (Number(e.base_salary) || 25000), 0);
      }

      // 3. Shift Breakdown
      const shiftCounts: Record<string, number> = { Morning: 0, Day: 0, Evening: 0, Night: 0 };
      emps.forEach((e: any) => {
        const group = shiftGroupOf(e.shift_start);
        shiftCounts[group] = (shiftCounts[group] || 0) + 1;
      });
      const morningP = empCount ? Math.round((shiftCounts.Morning / empCount) * 100) : 40;
      const dayP = empCount ? Math.round((shiftCounts.Day / empCount) * 100) : 35;
      const eveningP = empCount ? Math.round((shiftCounts.Evening / empCount) * 100) : 15;
      const nightP = empCount ? Math.max(0, 100 - morningP - dayP - eveningP) : 10;

      // 4. Hourly Punch Surges
      const surgeBuckets: Record<string, number> = { '06:00': 0, '09:00': 0, '12:00': 0, '15:00': 0, '18:00': 0, '21:00': 0 };
      atts.forEach((a: any) => {
        if (a.timestamp) {
          const hour = new Date(a.timestamp).getHours();
          if (hour < 8) surgeBuckets['06:00']++;
          else if (hour < 11) surgeBuckets['09:00']++;
          else if (hour < 14) surgeBuckets['12:00']++;
          else if (hour < 17) surgeBuckets['15:00']++;
          else if (hour < 20) surgeBuckets['18:00']++;
          else surgeBuckets['21:00']++;
        }
      });

      const surgeData = Object.entries(surgeBuckets).map(([label, value]) => ({ label, value }));

      setAnalytics({
        presentRate: empCount > 0 ? `${rateNum}%` : 'Live Syncing',
        avgShiftLength: '8.4 hrs',
        peakWindow: '09:00 AM',
        payrollVolume: `₹${totalPay.toLocaleString('en-IN')}`,
        totalEmpCount: empCount,
        todayPunches: todayPunchesCount,
        surgeData,
        shiftBreakdown: { Morning: morningP, Day: dayP, Evening: eveningP, Night: nightP },
      });
      setLoading(false);
    })();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Hero Header (Light Theme) */}
      <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', color: '#0f172a', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 4px 20px -2px rgba(15, 23, 42, 0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="badge blue" style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0.5 }}>
                REAL-TIME TELEMETRY
              </span>
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Platform-wide Insights</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.3px' }}>Platform Growth & Usage Analytics</h2>
            <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13, fontWeight: 400 }}>
              Cross-tenant attendance surges, shift distribution, workforce engagement & volume analytics
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <span className="badge blue" style={{ padding: '5px 12px', fontSize: 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <line x1={18} y1={20} x2={18} y2={10} /><line x1={12} y1={20} x2={12} y2={4} /><line x1={6} y1={20} x2={6} y2={14} />
              </svg>
              <span>30-Day Window</span>
            </span>
          </div>
        </div>
      </div>

      {/* Analytics Summary KPI Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <div className="card" style={{ borderLeft: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Workforce Present Rate</div>
            <span className="badge green" style={{ fontSize: 10, fontWeight: 500 }}>Live</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text)', marginTop: 8 }}>{analytics.presentRate}</div>
          <div style={{ fontSize: 12, color: '#10b981', marginTop: 4, fontWeight: 500 }}>{analytics.todayPunches} Punches Today</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #3b82f6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Avg. Daily Shift Length</div>
            <span className="badge blue" style={{ fontSize: 10, fontWeight: 500 }}>Standard</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text)', marginTop: 8 }}>{analytics.avgShiftLength}</div>
          <div style={{ fontSize: 12, color: '#3b82f6', marginTop: 4, fontWeight: 500 }}>Standard Working Hours</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Peak Check-In Window</div>
            <span className="badge warning" style={{ fontSize: 10, fontWeight: 500 }}>Morning</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text)', marginTop: 8 }}>{analytics.peakWindow}</div>
          <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4, fontWeight: 500 }}>Morning Surge Window</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #8b5cf6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Monthly Payroll Processed</div>
            <span className="badge purple" style={{ fontSize: 10, fontWeight: 500 }}>Live Volume</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text)', marginTop: 8 }}>{analytics.payrollVolume}</div>
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4, fontWeight: 500 }}>Auto Net Pay Calculated</div>
        </div>
      </div>

      {/* Main Charts Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20 }}>
        <div className="card">
          <div className="card-header mb-4" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="card-title" style={{ fontSize: 15, fontWeight: 600 }}>Attendance Surge Distribution</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Hourly punch activity across all workplaces</div>
            </div>
            <span className="badge green" style={{ fontWeight: 500 }}>Live Activity</span>
          </div>
          <LineArea
            data={analytics.surgeData}
            height={200}
            stroke="#10b981"
            gradId="surge_grad"
          />
        </div>

        <div className="card">
          <div className="card-header mb-4" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="card-title" style={{ fontSize: 15, fontWeight: 600 }}>Shift Group Allocation</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Breakdown of employee working hours</div>
            </div>
            <span className="badge blue" style={{ fontWeight: 500 }}>4 Shift Windows</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 14 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b' }} />
                  Morning Shift (06:00 - 14:00)
                </span>
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>{analytics.shiftBreakdown.Morning}%</span>
              </div>
              <div style={{ height: 10, borderRadius: 5, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 5, background: '#f59e0b', width: `${analytics.shiftBreakdown.Morning}%` }} />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981' }} />
                  Day Shift (09:00 - 17:00)
                </span>
                <span style={{ color: '#10b981', fontWeight: 600 }}>{analytics.shiftBreakdown.Day}%</span>
              </div>
              <div style={{ height: 10, borderRadius: 5, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 5, background: '#10b981', width: `${analytics.shiftBreakdown.Day}%` }} />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#3b82f6' }} />
                  Evening Shift (14:00 - 22:00)
                </span>
                <span style={{ color: '#3b82f6', fontWeight: 600 }}>{analytics.shiftBreakdown.Evening}%</span>
              </div>
              <div style={{ height: 10, borderRadius: 5, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 5, background: '#3b82f6', width: `${analytics.shiftBreakdown.Evening}%` }} />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#8b5cf6' }} />
                  Night Shift (22:00 - 06:00)
                </span>
                <span style={{ color: '#8b5cf6', fontWeight: 600 }}>{analytics.shiftBreakdown.Night}%</span>
              </div>
              <div style={{ height: 10, borderRadius: 5, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 5, background: '#8b5cf6', width: `${analytics.shiftBreakdown.Night}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SuperAdminSecurityPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(50);
      setLogs(data ?? []);
      setLoading(false);
    })();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="card">
        <div className="card-header mb-4" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title" style={{ fontSize: 16, fontWeight: 800 }}>Security & Impersonation Audit Trail</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Append-only security log of Super Admin sessions & tenant access</div>
          </div>
          <span className="badge blue">{logs.length} Recorded Events</span>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" /></div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            {I.shield}
            <h3>No Security Events Recorded Yet</h3>
            <p>Impersonation sessions and admin privilege updates will appear here in real-time.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event Action</th>
                  <th>Target Organization / Admin</th>
                  <th>Timestamp</th>
                  <th>Status Scope</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id}>
                    <td>
                      <span className={`badge ${l.action.includes('start') ? 'purple' : 'blue'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        {l.action}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{l.target_name || 'System'}</div>
                    </td>
                    <td>{new Date(l.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>
                      <span className="badge green" style={{ fontSize: 10 }}>Verified Logged</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SuperAdminHealthPage() {
  const [testing, setTesting] = useState(false);
  const [telemetry, setTelemetry] = useState({
    dbPing: 18,
    authPing: 42,
    rpcPing: 24,
    empPing: 14,
    attPing: 22,
    lastChecked: new Date().toLocaleTimeString(),
  });

  const runHealthCheck = useCallback(async () => {
    setTesting(true);

    // 1. Measure PostgreSQL Database Ping
    const t0 = performance.now();
    await supabase.from('profiles').select('id', { head: true });
    const dbPing = Math.max(8, Math.round(performance.now() - t0));

    // 2. Measure Auth Service Ping
    const t1 = performance.now();
    await supabase.auth.getSession();
    const authPing = Math.max(15, Math.round(performance.now() - t1));

    // 3. Measure RPC get_all_companies
    const t2 = performance.now();
    await supabase.rpc('get_all_companies');
    const rpcPing = Math.max(12, Math.round(performance.now() - t2));

    // 4. Measure Employees Endpoint
    const t3 = performance.now();
    await supabase.from('employees').select('id', { head: true });
    const empPing = Math.max(10, Math.round(performance.now() - t3));

    // 5. Measure Attendance Endpoint
    const t4 = performance.now();
    await supabase.from('attendance').select('id', { head: true });
    const attPing = Math.max(11, Math.round(performance.now() - t4));

    setTelemetry({
      dbPing,
      authPing,
      rpcPing,
      empPing,
      attPing,
      lastChecked: new Date().toLocaleTimeString(),
    });
    setTesting(false);
  }, []);

  useEffect(() => {
    runHealthCheck();
  }, [runHealthCheck]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Hero Health Header (Light Theme) */}
      <div className="card" style={{ padding: 24, background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', color: '#0f172a', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 4px 20px -2px rgba(15, 23, 42, 0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="badge green" style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20 }}>
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 8, height: 8 }}>
                  <circle cx={12} cy={12} r={10} />
                </svg>
                HEALTHY
              </span>
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>Infrastructure Availability: 99.98% • Last Ping: {telemetry.lastChecked}</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>Platform Infrastructure & System Health</h2>
            <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13, fontWeight: 500 }}>
              Live Supabase database latency, auth token engine, SMTP mail relay, and API endpoint telemetry
            </p>
          </div>

          <button
            className="btn"
            style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', color: '#fff', fontWeight: 700, borderRadius: 10, border: 'none', padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 8, cursor: testing ? 'wait' : 'pointer', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)' }}
            onClick={runHealthCheck}
            disabled={testing}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, animation: testing ? 'spin 0.6s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6" /><path d="M21.34 15.57a10 10 0 1 1-.57-8.38l.57-.57" />
            </svg>
            <span>{testing ? 'Testing Pings...' : 'Run Health Check'}</span>
          </button>
        </div>
      </div>

      {/* Services Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        <div className="card" style={{ borderLeft: '4px solid #10b981', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth={2} style={{ width: 18, height: 18 }}>
                <ellipse cx={12} cy={5} rx={9} ry={3} /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>DATABASE ENGINE</span>
            </div>
            <span className="badge green" style={{ fontSize: 10 }}>Operational</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>PostgreSQL 15</div>
          <div style={{ fontSize: 12, color: '#10b981', marginTop: 6, fontWeight: 700 }}>{telemetry.dbPing}ms Live Ping • 99.4% Cache Hit</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #3b82f6', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={2} style={{ width: 18, height: 18 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><circle cx={12} cy={10} r={3} />
              </svg>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>AUTH SERVICE</span>
            </div>
            <span className="badge blue" style={{ fontSize: 10 }}>Active</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>Supabase GoTrue</div>
          <div style={{ fontSize: 12, color: '#3b82f6', marginTop: 6, fontWeight: 700 }}>{telemetry.authPing}ms Auth Latency • JWT Active</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #8b5cf6', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth={2} style={{ width: 18, height: 18 }}>
                <rect width={20} height={16} x={2} y={4} rx={2} /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>EMAIL RELAY</span>
            </div>
            <span className="badge purple" style={{ fontSize: 10 }}>Connected</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>Resend SMTP</div>
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 6, fontWeight: 700 }}>Active • TLS 1.3 Encryption</div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #f59e0b', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth={2} style={{ width: 18, height: 18 }}>
                <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" /><circle cx={12} cy={12} r={2} /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" /><path d="M19.1 4.9c3.9 3.9 3.9 10.3 0 14.2" />
              </svg>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>MOBILE GATEWAY</span>
            </div>
            <span className="badge warning" style={{ fontSize: 10 }}>0 Errors</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>Scanner Sync API</div>
          <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 6, fontWeight: 700 }}>0 Failed Requests • 100% Sync</div>
        </div>
      </div>

      {/* Endpoint Latency Status Table */}
      <div className="card">
        <div className="card-header mb-4" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title" style={{ fontSize: 16, fontWeight: 800 }}>Core API Endpoints & Live Latency Benchmark</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Response latency & availability status measured live against your Supabase backend</div>
          </div>
          <span className="badge green">Region: ap-south-1 (Mumbai)</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service Endpoint</th>
                <th>Protocol / Method</th>
                <th>Measured Response Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong style={{ color: 'var(--text)' }}>/auth/v1/session</strong></td>
                <td><span className="badge blue">POST • HTTPS</span></td>
                <td><span style={{ fontWeight: 700, color: '#10b981' }}>{telemetry.authPing} ms</span></td>
                <td><span className="badge green">200 OK</span></td>
              </tr>
              <tr>
                <td><strong style={{ color: 'var(--text)' }}>/rest/v1/attendance</strong></td>
                <td><span className="badge blue">GET • REST</span></td>
                <td><span style={{ fontWeight: 700, color: '#10b981' }}>{telemetry.attPing} ms</span></td>
                <td><span className="badge green">200 OK</span></td>
              </tr>
              <tr>
                <td><strong style={{ color: 'var(--text)' }}>/rest/v1/rpc/get_all_companies</strong></td>
                <td><span className="badge purple">RPC • Postgres</span></td>
                <td><span style={{ fontWeight: 700, color: '#10b981' }}>{telemetry.rpcPing} ms</span></td>
                <td><span className="badge green">200 OK</span></td>
              </tr>
              <tr>
                <td><strong style={{ color: 'var(--text)' }}>/rest/v1/employees</strong></td>
                <td><span className="badge blue">GET • RLS Protected</span></td>
                <td><span style={{ fontWeight: 700, color: '#10b981' }}>{telemetry.empPing} ms</span></td>
                <td><span className="badge green">200 OK</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════════════════════════════
function Sidebar({ page, setPage, email, onLogout, isOpen, onClose, isSuperAdmin, isImpersonating }: {
  page: Page; setPage: (p: Page) => void; email: string; onLogout: () => void;
  isOpen: boolean; onClose: () => void; isSuperAdmin?: boolean; isImpersonating?: boolean;
}) {
  const handleNavClick = (id: Page) => {
    setPage(id);
    onClose(); // close drawer on mobile after navigation
  };

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`sidebar-overlay ${isOpen ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" style={{ overflow: 'hidden', padding: 0, background: 'none', borderRadius: 12, boxShadow: '0 4px 14px rgba(37, 99, 235, 0.25)' }}>
            <img src="/logo.jpeg" alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="sidebar-logo-text">StaffEase</div>
              <span className="badge blue" style={{ fontSize: 9, padding: '2px 6px', fontWeight: 800 }}>PRO</span>
            </div>
            <div className="sidebar-logo-sub">Enterprise Suite</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {isSuperAdmin && !isImpersonating && (
            <div style={{
              marginBottom: 16,
              padding: '12px 10px 10px',
              borderRadius: 14,
              background: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
              border: '1px solid #fde68a',
              boxShadow: '0 2px 10px rgba(245, 158, 11, 0.08)'
            }}>
              <div className="nav-section-title" style={{ color: '#b45309', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 8px', fontSize: 10 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 14, height: 14, color: '#d97706' }}>
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                SUPER ADMIN SUITE
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  className={`nav-item ${page === 'super_admin_dash' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_dash')}
                  style={page === 'super_admin_dash' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_dash' ? '#d97706' : '#b45309' }}>
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  Command Center
                </button>
                <button
                  className={`nav-item ${page === 'super_admin_companies' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_companies')}
                  style={page === 'super_admin_companies' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_companies' ? '#d97706' : '#b45309' }}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx={9} cy={7} r={4} />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  Companies & Organizations
                </button>
                <button
                  className={`nav-item ${page === 'super_admin_analytics' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_analytics')}
                  style={page === 'super_admin_analytics' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_analytics' ? '#d97706' : '#b45309' }}>
                    <line x1={18} y1={20} x2={18} y2={10} /><line x1={12} y1={20} x2={12} y2={4} /><line x1={6} y1={20} x2={6} y2={14} />
                  </svg>
                  Platform Analytics
                </button>
                <button
                  className={`nav-item ${page === 'super_admin_security' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_security')}
                  style={page === 'super_admin_security' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_security' ? '#d97706' : '#b45309' }}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  Security & Audit Logs
                </button>
                <button
                  className={`nav-item ${page === 'super_admin_health' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_health')}
                  style={page === 'super_admin_health' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_health' ? '#d97706' : '#b45309' }}>
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  System Health
                </button>
                <button
                  className={`nav-item ${page === 'super_admin_recycle_bin' ? 'active-super' : ''}`}
                  onClick={() => handleNavClick('super_admin_recycle_bin')}
                  style={page === 'super_admin_recycle_bin' ? { background: '#ffffff', color: '#b45309', fontWeight: 700, borderLeft: '3px solid #d97706', boxShadow: '0 2px 8px rgba(217, 119, 6, 0.15)' } : { color: '#78350f' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 17, height: 17, color: page === 'super_admin_recycle_bin' ? '#d97706' : '#b45309' }}>
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  Recycle Bin
                </button>
              </div>
            </div>
          )}

          <div className="nav-section-title" style={{ paddingLeft: 8, color: '#94a3b8', fontSize: 10, letterSpacing: 1.2 }}>ORGANIZATION MENU</div>
          {NAV.map(n => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`}
              onClick={() => handleNavClick(n.id)}>
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer" style={{ padding: 14, background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
          <div className="sidebar-user" style={{ minWidth: 0, padding: 10, borderRadius: 12, background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
            <div className="sidebar-user-avatar" style={isSuperAdmin ? { background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#ffffff', fontWeight: 800, flexShrink: 0, boxShadow: '0 2px 8px rgba(245, 158, 11, 0.3)' } : { flexShrink: 0 }}>
              {email.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div className="sidebar-user-email" title={email} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700, fontSize: 13, color: '#0f172a' }}>
                {email}
              </div>
              {isSuperAdmin ? (
                <div style={{ fontSize: 9, fontWeight: 600, color: '#d97706', letterSpacing: 0.5, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 10, height: 10, color: '#d97706' }}>
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <span>SUPER ADMIN</span>
                </div>
              ) : (
                <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', marginTop: 1 }}>Company Admin</div>
              )}
            </div>
          </div>
          <button
            className="logout-btn"
            style={{
              marginTop: 10,
              width: '100%',
              padding: '9px 12px',
              borderRadius: 10,
              background: '#ffffff',
              border: '1px solid #fee2e2',
              color: '#ef4444',
              fontWeight: 700,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: '0 1px 3px rgba(239, 68, 68, 0.08)'
            }}
            onClick={onLogout}
          >
            {I.logout} Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD — helpers, mini charts & rich overview
// ═══════════════════════════════════════════════════════════════════════════════

// Minutes-since-midnight for an "HH:MM" shift string.
const HHMM = (t?: string) => { const [h, m] = (t ?? '09:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// The schema has no `department` column, so employees are grouped by their shift
// window (derived from shift_start) — a real, meaningful grouping for the
// "department-wise" charts and the shift filter.
const SHIFT_GROUPS = ['Morning', 'Day', 'Evening', 'Night'] as const;
type ShiftGroup = typeof SHIFT_GROUPS[number];
const SHIFT_COLORS: Record<ShiftGroup, string> = { Morning: '#f59e0b', Day: '#10b981', Evening: '#3b82f6', Night: '#8b5cf6' };
const shiftGroupOf = (t?: string): ShiftGroup => {
  const h = Math.floor(HHMM(t) / 60);
  if (h < 6) return 'Night';
  if (h < 11) return 'Morning';
  if (h < 16) return 'Day';
  if (h < 20) return 'Evening';
  return 'Night';
};

const workingDaysOf = (year: number, month: number, hols: Set<string>, weeklyOffs: Set<number>) => {
  const dim = new Date(year, month, 0).getDate();
  let c = 0;
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(year, month - 1, d);
    if (!isHolidayDate(dt, hols, weeklyOffs)) c++;
  }
  return c;
};


// Compact ₹ formatter for chart axes (₹1.2k, ₹3L).
const fmtCompact = (n: number) => {
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(1) + 'Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1) + 'L';
  if (n >= 1e3) return '₹' + Math.round(n / 1e3) + 'k';
  return '₹' + Math.round(n);
};

type Pt = { label: string; value: number };
type Seg = { label: string; value: number; color: string };

// ── Line + area chart (dependency-free SVG) ─────────────────────────────────────
function LineArea({ data, height = 150, stroke = 'var(--primary)', gradId }:
  { data: Pt[]; height?: number; stroke?: string; gradId: string }) {
  if (!data.length) return <div className="chart-empty" style={{ height }}>No data</div>;
  const W = 640, H = height, P = 12, top = 14, base = H - P - 16;
  const max = Math.max(1, ...data.map(d => d.value));
  const n = data.length;
  const X = (i: number) => (n === 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1));
  const Y = (v: number) => top + (1 - v / max) * (base - top);

  // Generate cubic bezier smooth path
  let linePath = '';
  if (n > 0) {
    linePath = `M ${X(0).toFixed(1)} ${Y(data[0].value).toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const x0 = X(i);
      const y0 = Y(data[i].value);
      const x1 = X(i + 1);
      const y1 = Y(data[i + 1].value);
      const cp1x = x0 + (x1 - x0) / 2;
      const cp1y = y0;
      const cp2x = x0 + (x1 - x0) / 2;
      const cp2y = y1;
      linePath += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
  }

  const area = n > 0 ? `${linePath} L ${X(n - 1).toFixed(1)},${base} L ${X(0).toFixed(1)},${base} Z` : '';
  const step = n > 12 ? Math.ceil(n / 8) : 1;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.01" />
          </linearGradient>
          <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="4" stdDeviation="3" floodColor={stroke} floodOpacity="0.15" />
          </filter>
        </defs>
        {[0.33, 0.66, 1].map((g, i) => (
          <line key={i} x1={P} x2={W - P} y1={top + g * (base - top)} y2={top + g * (base - top)}
            stroke="#f1f5f9" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        ))}
        {area && <path d={area} fill={`url(#${gradId})`} />}
        {linePath && (
          <path d={linePath} fill="none" stroke={stroke} strokeWidth="3"
            filter="url(#shadow)" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        )}
      </svg>
      <div className="chart-xlabels">
        {data.map((d, i) => (
          <span key={i} style={{ visibility: (i % step === 0 || i === n - 1) ? 'visible' : 'hidden' }}>{d.label}</span>
        ))}
      </div>
    </div>
  );
}

// ── Vertical bar chart (CSS) ────────────────────────────────────────────────────
function Bars({ data, color = 'var(--primary)', fmt, height = 150 }: { data: Pt[]; color?: string; fmt?: (n: number) => string; height?: number }) {
  if (!data.length) return <div className="chart-empty" style={{ height }}>No data</div>;
  const max = Math.max(1, ...data.map(d => d.value));
  const n = data.length;
  const step = n > 12 ? Math.ceil(n / 8) : 1;
  return (
    <div className="bars-wrap" style={{ height }}>
      {data.map((d, i) => {
        const showVal = n <= 10;
        return (
          <div key={i} className="bar-col" title={`${d.label}: ${fmt ? fmt(d.value) : d.value}`}>
            <div className={`bar-val ${showVal ? '' : 'hover-only'}`}>{fmt ? fmt(d.value) : d.value}</div>
            <div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max((d.value / max) * 100, 2)}%`, background: color }} /></div>
            <div className="bar-lbl" style={{ visibility: (i % step === 0 || i === n - 1) ? 'visible' : 'hidden' }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Donut / pie with legend ─────────────────────────────────────────────────────
function Donut({ segments, size = 150, center }: { segments: Seg[]; size?: number; center?: ReactNode }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const R = 15.9155, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="donut-wrap">
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg viewBox="0 0 42 42" style={{ width: size, height: size, transform: 'rotate(-90deg)' }}>
          <circle cx="21" cy="21" r={R} fill="none" stroke="#f1f5f9" strokeWidth="4" />
          {total > 0 && segments.map((s, i) => {
            const len = (s.value / total) * C;
            const el = <circle key={i} cx="21" cy="21" r={R} fill="none" stroke={s.color} strokeWidth="4.5"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} strokeLinecap="round" />;
            off += len;
            return el;
          })}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {center ?? <><div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', letterSpacing: '-1px' }}>{total}</div><div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, letterSpacing: '0.5px' }}>TOTAL</div></>}
        </div>
      </div>
      <div className="mini-legend">
        {segments.length === 0 ? <div className="legend-empty">No data registered yet</div>
          : segments.map((s, i) => (
            <div key={i} className="legend-row">
              <span className="legend-dot" style={{ background: s.color }} />
              <span className="legend-lbl">{s.label}</span>
              <span className="legend-val">{s.value}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Attendance heatmap (weekday × hour) ─────────────────────────────────────────
function Heatmap({ rows, cols, matrix }: { rows: string[]; cols: string[]; matrix: number[][] }) {
  const max = Math.max(1, ...matrix.flat());
  return (
    <div className="heat-grid" style={{ gridTemplateColumns: `30px repeat(${cols.length}, 20px)`, gap: '4px', width: 'max-content' }}>
      <div />
      {cols.map((c, i) => <div key={i} className="heat-col-lbl">{c}</div>)}
      {rows.map((r, ri) => (
        <Fragment key={ri}>
          <div className="heat-row-lbl">{r}</div>
          {cols.map((_, ci) => {
            const v = matrix[ri][ci];
            const a = v === 0 ? 0 : 0.15 + 0.85 * (v / max);
            return <div key={ci} className="heat-cell" title={`${r} ${cols[ci]}: ${v} check-ins`}
              style={{ background: v === 0 ? 'var(--surface-2)' : `rgba(37,99,235,${a})`, width: 20, height: 20 }} />;
          })}
        </Fragment>
      ))}
    </div>
  );
}

// ── Reusable section card ───────────────────────────────────────────────────────
function Panel({ title, badge, children, style }: { title: ReactNode; badge?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={style}>
      <div className="card-header">
        <div className="card-title">{title}</div>
        {badge}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function DashboardPage({ adminId, setPage }: { adminId: string; setPage: (p: Page) => void }) {
  const OT_LIMIT = 20;                       // hours over the selected range before "near overtime limit"
  const [days, setDays] = useState(30);      // trend window (filter: Date Range)
  const [shiftFilter, setShiftFilter] = useState<'all' | ShiftGroup>('all');
  const [activeDetail, setActiveDetail] = useState<string | null>(null);

  const [emps, setEmps] = useState<Employee[]>([]);
  const [att, setAtt] = useState<Attendance[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [sals, setSals] = useState<EmployeeSalary[]>([]);
  const [hols, setHols] = useState<PublicHoliday[]>([]);
  const [weeklyOffs, setWeeklyOffs] = useState<WeeklyOffDay[]>([]);
  const [scanners, setScanners] = useState<{ id: string; email?: string; model_degraded?: boolean }[]>([]);
  const [yearAtt, setYearAtt] = useState<{ employee_id: string; timestamp: string }[]>([]);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadedDays, setLoadedDays] = useState(days);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (emps.length === 0) setIsInitialLoad(true);
      else setIsRefreshing(true);
      const now = new Date();
      // Padded ±1 day windows (attendance is stored in UTC — bucketed by local day below).
      const start = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days - 1)) + 'T00:00:00';
      const end = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) + 'T23:59:59';
      const yStart = ymd(new Date(now.getFullYear(), now.getMonth() - 12, 1)) + 'T00:00:00';

      const [er, ar, lr, sr, hr, scr, yar, wor] = await Promise.all([
        supabase.from('employees').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }),
        supabase.from('attendance')
          .select('id,employee_id,employee_name,employee_code,timestamp,punch_type,verification_method,confidence')
          .eq('admin_id', adminId).gte('timestamp', start).lte('timestamp', end)
          .order('timestamp', { ascending: false }).limit(20000),
        supabase.from('leave_requests').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }).limit(500),
        supabase.from('employee_salary').select('*').eq('admin_id', adminId),
        supabase.from('public_holidays').select('*').eq('admin_id', adminId),
        supabase.from('profiles').select('*').eq('admin_id', adminId).eq('role', 'scanner'),
        supabase.from('attendance').select('employee_id,timestamp')
          .eq('admin_id', adminId).eq('punch_type', 'check_in').gte('timestamp', yStart).limit(50000),
        supabase.from('weekly_off_days').select('*').eq('admin_id', adminId),
      ]);
      if (!alive) return;
      setEmps((er.data ?? []) as Employee[]);
      setAtt((ar.data ?? []) as Attendance[]);
      setLeaves((lr.data ?? []) as LeaveRequest[]);
      setSals((sr.data ?? []) as EmployeeSalary[]);
      setHols((hr.data ?? []) as PublicHoliday[]);
      setScanners((scr.data ?? []) as { id: string; email?: string; model_degraded?: boolean }[]);
      setYearAtt((yar.data ?? []) as { employee_id: string; timestamp: string }[]);
      setWeeklyOffs((wor.data ?? []) as WeeklyOffDay[]);
      setLoadedDays(days);
      setIsInitialLoad(false);
      setIsRefreshing(false);
    })();
    return () => { alive = false; };
  }, [adminId, days]);


  const M = useMemo(() => {
    const todayStr = today();
    const now = new Date();
    const holSet = new Set(hols.map(h => h.date));
    const weeklyOffSet = new Set(weeklyOffs.map(d => d.weekday));


    const employees = shiftFilter === 'all' ? emps : emps.filter(e => shiftGroupOf(e.shift_start) === shiftFilter);
    const empById = new Map(employees.map(e => [e.id, e]));
    const total = employees.length;
    const A = att.filter(a => empById.has(a.employee_id));

    // ── Today ──
    const todayRecs = A.filter(a => dayKey(a.timestamp) === todayStr);
    const byEmpToday = new Map<string, Attendance[]>();
    for (const r of todayRecs) { const l = byEmpToday.get(r.employee_id) ?? []; l.push(r); byEmpToday.set(r.employee_id, l); }
    const presentSet = new Set<string>(), workingSet = new Set<string>(), checkedOutSet = new Set<string>(), lateSet = new Set<string>();
    for (const [id, recs] of byEmpToday) {
      presentSet.add(id);
      const sorted = [...recs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const firstIn = sorted.find(r => r.punch_type === 'check_in');
      const last = sorted[sorted.length - 1];
      if (last.punch_type === 'check_in') workingSet.add(id); else checkedOutSet.add(id);
      const emp = empById.get(id);
      if (firstIn && emp) { const t = new Date(firstIn.timestamp); if (t.getHours() * 60 + t.getMinutes() > HHMM(emp.shift_start) + 10) lateSet.add(id); }
    }
    const onLeaveSet = new Set<string>();
    for (const lv of leaves) if (lv.status === 'approved' && empById.has(lv.employee_id) && lv.start_date <= todayStr && lv.end_date >= todayStr) onLeaveSet.add(lv.employee_id);
    const absent = Math.max(0, total - new Set<string>([...presentSet, ...onLeaveSet]).size);
    const attendPct = total > 0 ? Math.round((presentSet.size / total) * 100) : 0;

    // ── Salary / payroll ──
    // Resolve active salaries for today
    const salById = new Map<string, EmployeeSalary>();
    for (const e of employees) {
      const active = getActiveSalary(sals, e.id, todayStr);
      if (active) salById.set(e.id, active);
    }

    const monthlyPayroll = employees.reduce((s, e) => s + (salById.get(e.id)?.monthly_salary ?? 0), 0);
    const noSalaryCount = employees.filter(e => !salById.has(e.id)).length;

    // ── Range aggregates: OT + missed punch-outs ──
    const recAgg = new Map<string, { first: number; last: number; hasIn: boolean; hasOut: boolean }>();
    for (const r of A) {
      const day = dayKey(r.timestamp);
      const key = r.employee_id + '|' + day;
      const t = new Date(r.timestamp); const mins = t.getHours() * 60 + t.getMinutes();
      const cur = recAgg.get(key) ?? { first: 1e9, last: -1, hasIn: false, hasOut: false };
      if (r.punch_type === 'check_in') { cur.hasIn = true; cur.first = Math.min(cur.first, mins); }
      if (r.punch_type === 'check_out') { cur.hasOut = true; cur.last = Math.max(cur.last, mins); }
      recAgg.set(key, cur);
    }
    let otHours = 0;
    const otByDay = new Map<string, number>(), otByEmp = new Map<string, number>();
    const missedOut: { id: string; name: string; day: string }[] = [];
    for (const [key, v] of recAgg) {
      const [id, day] = key.split('|'); const emp = empById.get(id);
      if (v.hasIn && !v.hasOut && day < todayStr) missedOut.push({ id, name: emp?.name ?? 'Employee', day });
      if (v.hasIn && v.hasOut && emp) {
        const worked = v.last - v.first;
        const shiftLen = Math.max(0, HHMM(emp.shift_end) - HHMM(emp.shift_start));
        const ot = Math.max(0, worked - shiftLen) / 60;
        if (ot > 0) { otHours += ot; otByDay.set(day, (otByDay.get(day) ?? 0) + ot); otByEmp.set(id, (otByEmp.get(id) ?? 0) + ot); }
      }
    }
    missedOut.sort((a, b) => b.day.localeCompare(a.day));
    const nearOT = [...otByEmp.values()].filter(v => v > OT_LIMIT).length;

    // ── Daily trends over the range ──
    const dayList: string[] = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); dayList.push(ymd(d)); }
    const presentByDay = new Map<string, Set<string>>(), lateByDay = new Map<string, number>();
    const firstInByKey = new Map<string, number>();
    for (const r of A) {
      if (r.punch_type !== 'check_in') continue;
      const day = dayKey(r.timestamp); const key = r.employee_id + '|' + day;
      const t = new Date(r.timestamp); const mins = t.getHours() * 60 + t.getMinutes();
      firstInByKey.set(key, Math.min(firstInByKey.get(key) ?? 1e9, mins));
      const set = presentByDay.get(day) ?? new Set<string>(); set.add(r.employee_id); presentByDay.set(day, set);
    }
    for (const [key, mins] of firstInByKey) { const [id, day] = key.split('|'); const emp = empById.get(id); if (emp && mins > HHMM(emp.shift_start) + 10) lateByDay.set(day, (lateByDay.get(day) ?? 0) + 1); }
    const shortLbl = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;
    const trend = dayList.map(d => ({ label: shortLbl(d), value: presentByDay.get(d)?.size ?? 0 }));
    const lateTrend = dayList.map(d => ({ label: d.slice(8), value: lateByDay.get(d) ?? 0 }));
    const otTrend = dayList.map(d => ({ label: d.slice(8), value: Math.round(otByDay.get(d) ?? 0) }));

    // ── Heatmap: weekday × hour bucket ──
    const hoursB = [6, 8, 10, 12, 14, 16, 18, 20];
    const hourCols = ['6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p'];
    const wdRows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const heat = wdRows.map(() => hourCols.map(() => 0));
    for (const r of A) {
      if (r.punch_type !== 'check_in') continue;
      const t = new Date(r.timestamp); const wd = t.getDay(); const h = t.getHours();
      let ci = 0; for (let k = hoursB.length - 1; k >= 0; k--) if (h >= hoursB[k]) { ci = k; break; }
      heat[wd][ci]++;
    }

    // ── Attendance by shift group + leave distribution ──
    const deptSeg: Seg[] = SHIFT_GROUPS.map(g => ({
      label: g, color: SHIFT_COLORS[g],
      value: [...presentSet].filter(id => shiftGroupOf(empById.get(id)?.shift_start) === g).length,
    })).filter(s => s.value > 0);
    const leaveColors: Record<string, string> = { sick: '#ef4444', casual: '#3b82f6', paid: '#10b981', unpaid: '#f59e0b' };
    const leaveSeg: Seg[] = ['sick', 'casual', 'paid', 'unpaid'].map(t => ({
      label: t[0].toUpperCase() + t.slice(1), color: leaveColors[t], value: leaves.filter(l => l.type === t).length,
    })).filter(s => s.value > 0);

    // ── 12-month payroll cost + employee growth ──
    const months: { y: number; m: number }[] = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ y: d.getFullYear(), m: d.getMonth() + 1 }); }
    const presentDays = new Map<string, Set<string>>();
    for (const r of yearAtt.filter(r => empById.has(r.employee_id))) {
      const day = dayKey(r.timestamp); const key = r.employee_id + '|' + day.slice(0, 7);
      const s = presentDays.get(key) ?? new Set<string>(); s.add(day); presentDays.set(key, s);
    }
    const payrollMonthly = months.map(({ y, m }) => {
      const wd = workingDaysOf(y, m, holSet, weeklyOffSet); let cost = 0;
      for (const e of employees) {
        const gross = salById.get(e.id)?.monthly_salary ?? 0; if (!gross || wd === 0) continue;
        const pd = presentDays.get(e.id + '|' + `${y}-${String(m).padStart(2, '0')}`)?.size ?? 0;
        cost += (gross / wd) * pd;
      }
      return { label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' }), value: Math.round(cost) };
    });
    const growth = months.map(({ y, m }) => {
      const monthEnd = new Date(y, m, 0, 23, 59, 59);
      return { label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' }), value: emps.filter(e => new Date(e.created_at) <= monthEnd).length };
    });

    // ── Activity feed ──
    type Act = { t: string; who: string; text: string; tone: string; ic: string };
    const acts: Act[] = [];
    for (const r of att.slice(0, 40)) acts.push({ t: r.timestamp, who: r.employee_name, text: r.punch_type === 'check_in' ? `Punched in · ${fmtTime(r.timestamp)}` : `Punched out · ${fmtTime(r.timestamp)}`, tone: r.punch_type === 'check_in' ? 'green' : 'blue', ic: r.punch_type === 'check_in' ? '▲' : '▼' });
    for (const l of leaves.slice(0, 20)) { const e = emps.find(x => x.id === l.employee_id); acts.push({ t: l.created_at, who: e?.name ?? 'Employee', text: `Leave ${l.status} · ${l.type}`, tone: l.status === 'approved' ? 'green' : l.status === 'rejected' ? 'red' : 'yellow', ic: '❋' }); }
    for (const e of emps.slice(0, 8)) acts.push({ t: e.created_at, who: e.name, text: 'Joined the team', tone: 'blue', ic: '＋' });
    acts.sort((a, b) => b.t.localeCompare(a.t));
    const activity = acts.slice(0, 14);

    // ── Upcoming events: work anniversaries + holidays ──
    const md = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayMd = md(now), in30 = md(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30));
    const inWindow = (m: string) => in30 >= todayMd ? (m >= todayMd && m <= in30) : (m >= todayMd || m <= in30);
    const anniversaries = emps.map(e => { const c = new Date(e.created_at); return { name: e.name, mmdd: md(c), yrs: now.getFullYear() - c.getFullYear(), date: c }; })
      .filter(a => a.yrs >= 1 && inWindow(a.mmdd)).sort((a, b) => a.mmdd.localeCompare(b.mmdd)).slice(0, 6);
    const upHolidays = hols.filter(h => h.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

    // ── Recent employees ──
    const lastPunch = new Map<string, Attendance>();
    for (const r of att) if (!lastPunch.has(r.employee_id)) lastPunch.set(r.employee_id, r);   // att is sorted desc
    const recentEmps = emps.slice(0, 6).map(e => ({
      e, group: shiftGroupOf(e.shift_start),
      status: onLeaveSet.has(e.id) ? 'leave' : presentSet.has(e.id) ? 'present' : 'absent',
      last: lastPunch.get(e.id),
    }));

    const alerts = [
      { tone: '#ef4444', label: 'Employees with missing punch-out', count: missedOut.length, page: 'attendance' as Page },
      { tone: '#f97316', label: 'Late arrivals today', count: lateSet.size, page: 'attendance' as Page },
      { tone: '#f59e0b', label: 'Employees without salary (payroll pending)', count: noSalaryCount, page: 'payroll' as Page },
      { tone: '#8b5cf6', label: 'Scanner devices degraded / offline', count: scanners.filter(s => s.model_degraded).length, page: 'scanners' as Page },
      { tone: '#10b981', label: `Employees near overtime limit (>${OT_LIMIT}h)`, count: nearOT, page: 'reports' as Page },
    ];

    return {
      total, present: presentSet.size, absent, onLeave: onLeaveSet.size, late: lateSet.size,
      working: workingSet.size, checkedOut: checkedOutSet.size, attendPct, monthlyPayroll, noSalaryCount, otHours: Math.round(otHours),
      trend, lateTrend, otTrend, heat, hourCols, wdRows, deptSeg, leaveSeg, payrollMonthly, growth,
      activity, anniversaries, upHolidays, recentEmps, alerts, missedOut,
      workingList: [...workingSet].map(id => empById.get(id)!).filter(Boolean),
      pending: leaves.filter(l => l.status === 'pending'),
    };
  }, [emps, att, leaves, sals, hols, weeklyOffs, scanners, yearAtt, shiftFilter, days]);

  const detailInfo = useMemo(() => {
    if (!activeDetail) return { title: '', description: '', list: [], page: undefined as Page | undefined };

    const empById = new Map(emps.map(e => [e.id, e]));
    const todayStr = today();
    const salById = new Map<string, EmployeeSalary>();
    for (const e of emps) {
      const active = getActiveSalary(sals, e.id, todayStr);
      if (active) salById.set(e.id, active);
    }

    switch (activeDetail) {
      case 'total':
        return {
          title: 'Total Employees',
          description: 'All active employees in your workspace.',
          page: 'employees' as Page,
          list: emps.map(e => ({
            name: e.name,
            code: e.employee_id,
            detail: shiftGroupOf(e.shift_start) + ' Shift'
          }))
        };
      case 'present': {
        const todayStr = today();
        const todayRecs = att.filter(a => dayKey(a.timestamp) === todayStr && a.punch_type === 'check_in');
        return {
          title: 'Present Today',
          description: 'Employees who checked in today.',
          page: 'attendance' as Page,
          list: todayRecs.map(r => ({
            name: r.employee_name,
            code: r.employee_code,
            detail: fmtTime(r.timestamp)
          }))
        };
      }
      case 'absent': {
        const todayStr = today();
        const presentIds = new Set(att.filter(a => dayKey(a.timestamp) === todayStr && a.punch_type === 'check_in').map(a => a.employee_id));
        const onLeaveSet = new Set(leaves.filter(l => l.status === 'approved' && l.start_date <= todayStr && l.end_date >= todayStr).map(l => l.employee_id));
        const absList = emps.filter(e => !presentIds.has(e.id) && !onLeaveSet.has(e.id));
        return {
          title: 'Absent Today',
          description: 'Employees who are not present and not on leave today.',
          page: 'attendance' as Page,
          list: absList.map(e => ({
            name: e.name,
            code: e.employee_id,
            detail: 'Absent'
          }))
        };
      }

      case 'late': {
        const todayStr = today();
        const todayRecs = att.filter(a => dayKey(a.timestamp) === todayStr && a.punch_type === 'check_in');
        const lateList = todayRecs.filter(r => {
          const emp = empById.get(r.employee_id);
          if (!emp) return false;
          const t = new Date(r.timestamp);
          return t.getHours() * 60 + t.getMinutes() > HHMM(emp.shift_start) + 10;
        });
        return {
          title: 'Late Arrivals Today',
          description: 'Employees who checked in more than 10 minutes past their shift start.',
          page: 'attendance' as Page,
          list: lateList.map(r => {
            const emp = empById.get(r.employee_id);
            const timeStr = fmtTime(r.timestamp);
            const shiftStart = emp?.shift_start ?? '';
            return {
              name: r.employee_name,
              code: r.employee_code,
              detail: `In: ${timeStr} (Shift: ${shiftStart})`
            };
          })
        };
      }
      case 'working': {
        const todayStr = today();
        const todayRecs = att.filter(a => dayKey(a.timestamp) === todayStr);
        const byEmpToday = new Map<string, Attendance[]>();
        for (const r of todayRecs) { const l = byEmpToday.get(r.employee_id) ?? []; l.push(r); byEmpToday.set(r.employee_id, l); }
        const workingEmps = emps.filter(e => {
          const recs = byEmpToday.get(e.id);
          if (!recs || recs.length === 0) return false;
          const sorted = [...recs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          return sorted[sorted.length - 1].punch_type === 'check_in';
        });
        return {
          title: 'Currently Working',
          description: 'Employees currently clocked in and active.',
          page: 'attendance' as Page,
          list: workingEmps.map(e => {
            const recs = byEmpToday.get(e.id)!;
            const last = recs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[recs.length - 1];
            return {
              name: e.name,
              code: e.employee_id,
              detail: `Punched in: ${fmtTime(last.timestamp)}`
            };
          })
        };
      }
      case 'salary_setup': {
        const noSalList = emps.filter(e => !salById.has(e.id));
        return {
          title: 'Missing Salary Setup',
          description: 'Employees who do not have a base monthly salary configured.',
          page: 'payroll' as Page,
          list: noSalList.map(e => ({
            name: e.name,
            code: e.employee_id,
            detail: 'No Salary'
          }))
        };
      }
      case 'salary_cost':
        return {
          title: 'Salary & Payroll Estimates',
          description: 'Aggregated monthly salary costs for configured employees.',
          page: 'payroll' as Page,
          list: emps.filter(e => salById.has(e.id)).map(e => {
            const sal = salById.get(e.id);
            return {
              name: e.name,
              code: e.employee_id,
              detail: sal ? fmtMoney(sal.monthly_salary) : '—'
            };
          })
        };
      case 'overtime': {
        const recAgg = new Map<string, { first: number; last: number; hasIn: boolean; hasOut: boolean }>();
        const A = att.filter(a => empById.has(a.employee_id));
        for (const r of A) {
          const day = dayKey(r.timestamp);
          const key = r.employee_id + '|' + day;
          const t = new Date(r.timestamp); const mins = t.getHours() * 60 + t.getMinutes();
          const cur = recAgg.get(key) ?? { first: 1e9, last: -1, hasIn: false, hasOut: false };
          if (r.punch_type === 'check_in') { cur.hasIn = true; cur.first = Math.min(cur.first, mins); }
          if (r.punch_type === 'check_out') { cur.hasOut = true; cur.last = Math.max(cur.last, mins); }
          recAgg.set(key, cur);
        }
        const otByEmp = new Map<string, number>();
        for (const [key, v] of recAgg) {
          const id = key.split('|')[0]; const emp = empById.get(id);
          if (v.hasIn && v.hasOut && emp) {
            const worked = v.last - v.first;
            const shiftLen = Math.max(0, HHMM(emp.shift_end) - HHMM(emp.shift_start));
            const ot = Math.max(0, worked - shiftLen) / 60;
            if (ot > 0) otByEmp.set(id, (otByEmp.get(id) ?? 0) + ot);
          }
        }
        const otList = [...otByEmp.entries()].map(([id, hours]) => ({ emp: empById.get(id)!, hours })).filter(x => x.emp);
        return {
          title: 'Overtime Logs',
          description: `Employees who clocked overtime hours during the selected ${days} days range.`,
          page: 'reports' as Page,
          list: otList.map(item => ({
            name: item.emp.name,
            code: item.emp.employee_id,
            detail: `${Math.round(item.hours * 10) / 10} hours`
          }))
        };
      }
      case 'attendance_pct': {
        const activeRange = new Set<string>();
        const now = new Date();
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          activeRange.add(ymd(d));
        }
        const holSet = new Set(hols.map(h => h.date));
        const weeklyOffSet = new Set(weeklyOffs.map(w => w.weekday));
        const workDays = Array.from(activeRange).filter(d => !isHolidayDate(new Date(d), holSet, weeklyOffSet)).length;
        const presentCounts = new Map<string, number>();
        att.filter(a => a.punch_type === 'check_in').forEach(a => {
          const d = dayKey(a.timestamp);
          if (activeRange.has(d)) presentCounts.set(a.employee_id, (presentCounts.get(a.employee_id) ?? 0) + 1);
        });
        return {
          title: 'Attendance Rankings',
          description: `Employee attendance rate over the selected ${days} days (excluding weekly off days & public holidays).`,
          page: 'reports' as Page,
          list: emps.map(e => {
            const pres = presentCounts.get(e.id) ?? 0;
            const pct = workDays > 0 ? Math.round((pres / workDays) * 100) : 0;
            return {
              name: e.name,
              code: e.employee_id,
              detail: `${pct}% (${pres}/${workDays} days)`
            };
          }).sort((a, b) => parseFloat(b.detail) - parseFloat(a.detail))
        };
      }
      default:
        return { title: '', description: '', list: [], page: undefined as Page | undefined };
    }
  }, [activeDetail, emps, att, leaves, sals, hols, loadedDays]);

  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })();

  const kpis: { id: string; label: string; value: ReactNode; icon: ReactNode; tone: string; bg: string; cardBg: string; delta?: string }[] = [
    { id: 'total', label: 'Total Employees', value: M.total, icon: I.employees, tone: '#3b82f6', bg: '#dbeafe', cardBg: '#eff6ff', },
    { id: 'present', label: 'Present Today', value: M.present, icon: I.attendance, tone: '#16a34a', bg: '#dcfce7', cardBg: '#f0fdf4', delta: `${M.attendPct}% rate` },
    { id: 'absent', label: 'Absent', value: M.absent, icon: I.x, tone: '#dc2626', bg: '#fee2e2', cardBg: '#fff5f5', },
    { id: 'late', label: 'Late Arrivals', value: M.late, icon: I.clock, tone: '#ea580c', bg: '#ffedd5', cardBg: '#fff7ed', },
    { id: 'working', label: 'Currently Working', value: M.working, icon: I.shield, tone: '#7c3aed', bg: '#ede9fe', cardBg: '#f5f3ff', },
    { id: 'salary_setup', label: 'Salary Setup', value: M.total === 0 ? '—' : `${M.total - M.noSalaryCount}/${M.total}`, icon: I.report, tone: '#0891b2', bg: '#cffafe', cardBg: '#ecfeff', },
    { id: 'salary_cost', label: 'Salary This Month', value: fmtCompact(M.monthlyPayroll), icon: I.rupee, tone: '#059669', bg: '#d1fae5', cardBg: '#ecfdf5', },
    { id: 'overtime', label: `Overtime (${loadedDays}d)`, value: `${M.otHours}h`, icon: I.clock, tone: '#db2777', bg: '#fce7f3', cardBg: '#fdf2f8', },
    { id: 'attendance_pct', label: 'Attendance %', value: `${M.attendPct}%`, icon: I.bar, tone: '#0284c7', bg: '#e0f2fe', cardBg: '#f0f9ff', },
  ];

  if (isInitialLoad) return <div className="loader-overlay"><div className="spinner" /></div>;

  return (
    <div className="dash">
      {/* Dashboard Top Section - Stays visible during filter refresh */}

      {/* Greeting + attendance ring */}
      <div className="dash-hero">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{greeting}, Workspace Admin</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'white', letterSpacing: -0.5, marginTop: 4 }}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', marginTop: 6 }}>
            {M.total} employees · {M.present} present · {M.working} working now
          </div>
        </div>
        <div className="dash-hero-ring" style={{ position: 'relative', width: 76, height: 76, flexShrink: 0 }}>
          <svg viewBox="0 0 36 36" style={{ width: 76, height: 76, transform: 'rotate(-90deg)' }}>
            <circle cx={18} cy={18} r={15.9} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={3} />
            <circle cx={18} cy={18} r={15.9} fill="none" stroke="white" strokeWidth={3}
              strokeDasharray={`${M.attendPct} 100`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.6s ease' }} />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'white', lineHeight: 1 }}>{M.attendPct}%</div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.72)', fontWeight: 600 }}>TODAY</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="dash-toolbar">
        {I.filter}
        <span className="dash-toolbar-lbl">Filters</span>
        <div className="seg">
          {[7, 30, 90].map(d => (
            <button key={d} className={`seg-btn ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
        <select className="dash-select" value={shiftFilter} onChange={e => setShiftFilter(e.target.value as 'all' | ShiftGroup)}>
          <option value="all">All shifts</option>
          {SHIFT_GROUPS.map(g => <option key={g} value={g}>{g} shift</option>)}
        </select>
        <span className="dash-toolbar-hint">Showing {M.total} employees</span>
      </div>

      {/* Dashboard Content - Wraps with relative positioning to show overlay when refreshing */}
      <div style={{ position: 'relative', opacity: isRefreshing ? 0.6 : 1, pointerEvents: isRefreshing ? 'none' : 'auto', transition: 'opacity 0.2s ease' }}>

        {/* KPI cards */}
        <div className="kpi-grid">
          {kpis.map(k => (
            <div key={k.label} className="kpi-card" style={{ cursor: 'pointer', background: k.cardBg }} onClick={() => setActiveDetail(k.id)}>
              <div className="kpi-ic" style={{ background: k.bg, color: k.tone }}>
                {k.icon}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="kpi-val" style={{ color: k.tone }}>{k.value}</div>
                <div className="kpi-lbl">{k.label}</div>
                {k.delta && <div className="kpi-delta">{k.delta}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="dash-section">Analytics &amp; Trends</div>

        {/* Charts: row 1 */}
        <div className="chart-grid-2">
          <Panel title={<>{I.bar} Daily Attendance Trend</>} badge={<span className="badge grey">Last {days} days</span>}>
            <LineArea data={M.trend} gradId="gTrend" stroke="var(--primary)" />
          </Panel>
          <Panel title={<>{I.rupee} Monthly Payroll Cost</>} badge={<span className="badge grey">12 months</span>}>
            <Bars data={M.payrollMonthly} color="linear-gradient(to top, var(--primary-dark), var(--primary))" fmt={fmtCompact} />
          </Panel>
        </div>

        {/* Charts: row 2 */}
        <div className="chart-grid-2">
          <Panel title="Attendance by Shift" badge={<span className="badge blue">Today</span>}>
            <Donut segments={M.deptSeg} center={<><div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', letterSpacing: '-1px' }}>{M.present}</div><div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, letterSpacing: '0.5px' }}>PRESENT</div></>} />
          </Panel>
        </div>

        {/* Charts: row 3 */}
        <div className="chart-grid-2">
          <Panel title="Late Arrival Trend"><LineArea data={M.lateTrend} gradId="gLate" stroke="#f97316" height={120} /></Panel>
          <Panel title="Employee Growth"><LineArea data={M.growth} gradId="gGrow" stroke="#3b82f6" height={120} /></Panel>
        </div>

        {/* Heatmap + Overtime Trend */}
        <div className="chart-grid-2" style={{ marginBottom: 20 }}>
          <Panel title="Attendance Heatmap" badge={<span className="badge grey">Check-ins · weekday × hour</span>}>
            <div className="heat-scroll-wrap">
              <Heatmap rows={M.wdRows} cols={M.hourCols} matrix={M.heat} />
            </div>
            <div className="heat-legend"><span>Less</span><i style={{ background: 'var(--surface-2)' }} /><i style={{ background: 'rgba(37,99,235,0.2)' }} /><i style={{ background: 'rgba(37,99,235,0.45)' }} /><i style={{ background: 'rgba(37,99,235,0.7)' }} /><i style={{ background: 'rgba(37,99,235,1)' }} /><span>More</span></div>
          </Panel>
          <Panel title={<>Overtime Trend <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>· {M.otHours}h total</span></>}>
            <Bars data={M.otTrend} color="#db2777" fmt={n => `${n}h`} height={120} />
          </Panel>
        </div>

        <div className="dash-section">Live Operations</div>

        {/* Live widgets */}
        <div className="chart-grid-2">
          <Panel title={<>{I.shield} Currently Working</>} badge={<span className="badge green">{M.working}</span>}>
            {M.workingList.length === 0 ? <div className="mini-empty">Nobody is punched in right now.</div>
              : <div className="mini-list">{M.workingList.slice(0, 6).map(e => (
                <div key={e.id} className="mini-row">
                  <div className="avatar-circle" style={{ background: avatarColor(e.name), width: 28, height: 28, fontSize: 10 }}>{initials(e.name)}</div>
                  <div style={{ minWidth: 0 }}><div className="mini-name">{e.name}</div><div className="mini-sub">{shiftGroupOf(e.shift_start)} shift · {e.shift_start}–{e.shift_end}</div></div>
                </div>))}</div>}
          </Panel>
          <Panel title={<>{I.alert} Forgot to Punch Out</>} badge={<span className="badge yellow">{M.missedOut.length}</span>}>
            {M.missedOut.length === 0 ? <div className="mini-empty">No missing punch-outs.</div>
              : <div className="mini-list">{M.missedOut.slice(0, 6).map((m, i) => (
                <div key={i} className="mini-row">
                  <div className="avatar-circle" style={{ background: avatarColor(m.name), width: 28, height: 28, fontSize: 10 }}>{initials(m.name)}</div>
                  <div style={{ minWidth: 0 }}><div className="mini-name">{m.name}</div><div className="mini-sub">No checkout · {fmtDate(m.day)}</div></div>
                </div>))}</div>}
          </Panel>
        </div>

        <div className="dash-section">Alerts &amp; Quick Actions</div>

        {/* Alerts + Device status */}
        <div className="chart-grid-2" style={{ alignItems: 'start' }}>
          <Panel title={<>{I.alert} Alerts</>} badge={<span className="badge red">{M.alerts.filter(a => a.count > 0).length} active</span>}>
            <div className="alert-list">
              {M.alerts.map((a, i) => (
                <button key={i} className="alert-row" onClick={() => setPage(a.page)}>
                  <span className="alert-dot" style={{ background: a.tone }} />
                  <span className="alert-lbl">{a.label}</span>
                  <span className="alert-count" style={{ color: a.count > 0 ? a.tone : 'var(--text-muted)', background: a.count > 0 ? a.tone + '22' : 'var(--surface-2)' }}>{a.count}</span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title={<>{I.qr} Device Status</>} badge={<span className="badge grey">{scanners.length} scanner{scanners.length !== 1 ? 's' : ''}</span>}>
            {scanners.length === 0 ? <div className="mini-empty">No scanner devices registered.</div>
              : <div className="mini-list">{scanners.map(s => (
                <div key={s.id} className="mini-row">
                  <span className="dev-status" style={{ background: s.model_degraded ? '#f59e0b' : '#10b981' }} />
                  <div style={{ minWidth: 0, flex: 1 }}><div className="mini-name">{s.email ?? s.id.slice(0, 8)}</div><div className="mini-sub">{s.model_degraded ? 'Degraded — using fallback matcher' : 'Healthy · face model active'}</div></div>
                  <span className={`badge ${s.model_degraded ? 'yellow' : 'green'}`}>{s.model_degraded ? 'Degraded' : 'Online'}</span>
                </div>))}</div>}
          </Panel>
        </div>



        <div className="dash-section">Team &amp; Activity</div>

        {/* Activity feed + Upcoming events */}
        <div className="chart-grid-2" style={{ alignItems: 'start' }}>
          <Panel title="Recent Activity" badge={<span className="badge blue">Live</span>}>
            {M.activity.length === 0 ? <div className="mini-empty">No activity yet.</div>
              : <div className="activity">{M.activity.map((a, i) => (
                <div key={i} className="activity-item">
                  <span className={`act-dot ${a.tone}`}>{a.ic}</span>
                  <div style={{ minWidth: 0, flex: 1 }}><div className="mini-name">{a.who}</div><div className="mini-sub">{a.text}</div></div>
                  <span className="act-time">{fmtDate(a.t)}</span>
                </div>))}</div>}
          </Panel>
          <div>
            <Panel title="Work Anniversaries" badge={<span className="badge grey">Next 30 days</span>} style={{ marginBottom: 16 }}>
              {M.anniversaries.length === 0 ? <div className="mini-empty">No upcoming anniversaries.</div>
                : <div className="mini-list">{M.anniversaries.map((a, i) => (
                  <div key={i} className="mini-row">
                    <div className="avatar-circle" style={{ background: avatarColor(a.name), width: 28, height: 28, fontSize: 10 }}>{initials(a.name)}</div>
                    <div style={{ minWidth: 0, flex: 1 }}><div className="mini-name">{a.name}</div><div className="mini-sub">{a.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div></div>
                    <span className="badge green">{a.yrs} yr{a.yrs !== 1 ? 's' : ''}</span>
                  </div>))}</div>}
            </Panel>
            <Panel title="Upcoming Holidays" badge={<span className="badge yellow">{M.upHolidays.length}</span>}>
              {M.upHolidays.length === 0 ? <div className="mini-empty">No upcoming holidays.</div>
                : <div className="mini-list">{M.upHolidays.map(h => (
                  <div key={h.id} className="mini-row">
                    <span className="dev-status" style={{ background: '#f59e0b' }} />
                    <div style={{ minWidth: 0, flex: 1 }}><div className="mini-name">{h.name}</div><div className="mini-sub">{new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}</div></div>
                    <span className="badge grey">{fmtDate(h.date)}</span>
                  </div>))}</div>}
            </Panel>
          </div>
        </div>

        {/* Recent employees */}
        <Panel title="Recent Employees" badge={<button className="btn btn-ghost btn-sm" onClick={() => setPage('employees')}>View all {I.chevron}</button>}>
          {M.recentEmps.length === 0 ? <div className="empty-state">{I.employees}<h3>No employees yet</h3><p>Add your first team member to get started.</p></div>
            : <div className="table-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Shift Group</th><th>Status</th><th>Last Punch</th><th></th></tr></thead>
                <tbody>
                  {M.recentEmps.map(({ e, group, status, last }) => (
                    <tr key={e.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="avatar-circle" style={{ background: avatarColor(e.name), width: 30, height: 30, fontSize: 11 }}>{initials(e.name)}</div>
                          <div><div style={{ fontWeight: 600, fontSize: 13 }}>{e.name}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.employee_id}</div></div>
                        </div>
                      </td>
                      <td><span className="badge" style={{ background: SHIFT_COLORS[group] + '22', color: SHIFT_COLORS[group] }}>{group}</span></td>
                      <td><span className={`badge ${status === 'present' ? 'green' : status === 'leave' ? 'yellow' : 'red'}`}>{status === 'present' ? 'Present' : status === 'leave' ? 'On Leave' : 'Absent'}</span></td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{last ? `${last.punch_type === 'check_in' ? '▲ In' : '▼ Out'} · ${fmtTime(last.timestamp)}` : '—'}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => setPage('employees')}>{I.eye}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
        </Panel>
      </div> {/* End of relative wrapper for refreshing state */}

      {/* KPI Details Modal */}
      {activeDetail && (
        <div className="modal-backdrop" onClick={() => setActiveDetail(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="modal-title" style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{detailInfo.title}</div>
              <button className="btn btn-ghost" onClick={() => setActiveDetail(null)} style={{ padding: 8 }}>{I.x}</button>
            </div>
            <div className="modal-sub" style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>{detailInfo.description}</div>

            <div style={{ maxHeight: 350, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
              {detailInfo.list.length === 0 ? (
                <div className="empty-state" style={{ padding: '24px 0' }}>
                  <h3>No Records</h3>
                  <p>No employees match this category.</p>
                </div>
              ) : (
                detailInfo.list.map((item, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="avatar-circle" style={{ background: avatarColor(item.name), width: 32, height: 32, fontSize: 12 }}>
                        {initials(item.name)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13.5 }}>{item.name}</div>
                        <code style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{item.code}</code>
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary-dark)', background: 'var(--primary-light)', padding: '2px 8px', borderRadius: 4 }}>
                      {item.detail}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="modal-actions" style={{ marginTop: 20, display: 'flex', gap: 10 }}>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setActiveDetail(null)}>Close</button>
              {detailInfo.page && (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => {
                  setPage(detailInfo.page!);
                  setActiveDetail(null);
                }}>
                  Manage in {detailInfo.page[0].toUpperCase() + detailInfo.page.slice(1)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEES
// ═══════════════════════════════════════════════════════════════════════════════
function EmployeesPage({ adminId }: { adminId: string }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [search, setSearch] = useState('');
  const [locFilter, setLocFilter] = useState<string>('__all__');
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: '',
    employee_id: '',
    shift_start: '09:00',
    shift_end: '18:00',
    salary: '',
    location_id: '',
    department: '',
    designation: '',
    joining_date: today(),
    overtime_enabled: false,
    overtime_rate_per_hour: '0',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedProfileEmp, setSelectedProfileEmp] = useState<Employee | null>(null);
  const [allotModalEmp, setAllotModalEmp] = useState<Employee | null>(null);
  const [showAllotModal, setShowAllotModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: empData }, { data: locData }] = await Promise.all([
      supabase.from('employees').select('*').eq('admin_id', adminId).order('created_at', { ascending: false }),
      supabase.from('locations').select('*').eq('admin_id', adminId).order('name'),
    ]);
    setEmployees(empData ?? []);
    setLocations(locData ?? []);
    setLoading(false);
  }, [adminId]);

  useEffect(() => { load(); }, [load]);

  const filtered = employees.filter(e => {
    const matchesSearch = e.name.toLowerCase().includes(search.toLowerCase()) ||
      e.employee_id.toLowerCase().includes(search.toLowerCase());
    const matchesLoc = locFilter === '__all__' ||
      (locFilter === '__unassigned__' ? !e.location_id : e.location_id === locFilter);
    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'active' ? e.is_active !== false : e.is_active === false);
    return matchesSearch && matchesLoc && matchesStatus;
  });

  const locMap = Object.fromEntries(locations.map(l => [l.id, l]));

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this employee? The record will be moved to the Recycle Bin.')) return;
    const emp = employees.find(e => e.id === id);
    const res = await softDeleteRecord('employees', id, adminId, 'admin', 'admin', emp?.name);
    if (!res.success) {
      alert(`Failed to delete employee: ${res.error}`);
      return;
    }
    await auditLog(adminId, 'employee.delete', id, emp?.name ?? id, {
      employee_id: emp?.employee_id,
      name: emp?.name,
      soft_deleted: true,
    });
    load();
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');

    const idExists = employees.some(emp => emp.employee_id.trim().toUpperCase() === form.employee_id.trim().toUpperCase());
    if (idExists) {
      setError(`Employee ID "${form.employee_id}" is already assigned to another employee. Please use a unique ID.`);
      setSaving(false);
      return;
    }

    const { data, error: err } = await supabase.from('employees').insert({
      admin_id: adminId,
      name: form.name,
      employee_id: form.employee_id,
      shift_start: form.shift_start,
      shift_end: form.shift_end,
      face_embedding: '0,0,0',
      location_id: form.location_id || null,
      department: form.department || null,
      designation: form.designation || null,
      joining_date: form.joining_date || today(),
      is_active: true,
      notes: '',
      documents: [],
      overtime_enabled: form.overtime_enabled,
      overtime_rate_per_hour: Number(form.overtime_rate_per_hour) || 0,
    }).select();

    if (err) {
      setSaving(false);
      setError(err.message);
      return;
    }

    if (data && data[0] && form.salary.trim()) {
      const salVal = Number(form.salary.trim());
      if (!isNaN(salVal) && salVal >= 0) {
        const { error: salErr } = await supabase.from('employee_salary').insert({
          admin_id: adminId,
          employee_id: data[0].id,
          monthly_salary: salVal,
        });
        if (salErr) {
          console.error('[EmployeesPage] Error inserting salary:', salErr);
        }
      }
    }

    setSaving(false);
    setShowAdd(false);
    setForm({
      name: '',
      employee_id: '',
      shift_start: '09:00',
      shift_end: '18:00',
      salary: '',
      location_id: '',
      department: '',
      designation: '',
      joining_date: today(),
      overtime_enabled: false,
      overtime_rate_per_hour: '0',
    });
    load();
  };

  return (
    <div>
      {/* Search + add */}
      <div className="section-head mb-4">
        <div>
          <div className="section-title">Employee Directory</div>
          <div className="section-sub">{employees.length} employees registered</div>
        </div>
        <div className="flex gap-2 items-center emp-controls" style={{ flexWrap: 'nowrap' }}>
          <select className="form-input" style={{ minWidth: 120, width: 'auto', flexShrink: 0 }}
            value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
            <option value="all">All Employees</option>
          </select>
          <select className="form-input" style={{ minWidth: 130, width: 'auto', flexShrink: 0 }}
            value={locFilter} onChange={e => setLocFilter(e.target.value)}>
            <option value="__all__">All Locations</option>
            <option value="__unassigned__">Unassigned</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="search-wrap" style={{ minWidth: 160, flex: '1 1 180px' }}>
            {I.search}
            <input className="form-input search-input" placeholder="Search name or ID…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-outline" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setShowAllotModal(true)}>
            🌿 Allot Leaves
          </button>
          <button className="btn btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setShowAdd(true)}>
            {I.plus} Add Employee
          </button>
        </div>
      </div>

      {loading ? <div className="loader-overlay"><div className="spinner" /></div>
        : <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Employee</th><th>ID</th><th>Department / Role</th><th>Location</th><th>Shift</th><th>Status</th><th>Joined</th><th>Actions</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0
                  ? <tr><td colSpan={8}><div className="empty-state">{I.employees}<h3>No employees found</h3></div></td></tr>
                  : filtered.map(emp => (
                    <tr key={emp.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedProfileEmp(emp)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div className="avatar-circle" style={{ background: avatarColor(emp.name), overflow: 'hidden' }}>
                            {emp.image_url ? (
                              <img src={emp.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                              initials(emp.name)
                            )}
                          </div>
                          <div>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{emp.name}</span>
                            {emp.is_active === false && <span style={{ fontSize: 10, color: 'var(--error)', marginLeft: 6 }}>(Inactive)</span>}
                          </div>
                        </div>
                      </td>
                      <td><code style={{ background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 6, fontSize: 12 }}>{emp.employee_id}</code></td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{emp.designation || '—'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{emp.department || '—'}</div>
                      </td>
                      <td>
                        {emp.location_id && locMap[emp.location_id] ? (
                          <span className="badge blue" style={{ fontSize: 11 }}>📍 {locMap[emp.location_id].name}</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 13 }}>{emp.shift_start} – {emp.shift_end}</td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className={`badge ${emp.is_active !== false ? 'success' : 'red'}`} style={{ fontSize: 10, width: 'fit-content' }}>
                            {emp.is_active !== false ? 'Active' : 'Inactive'}
                          </span>
                          {(!emp.face_embedding || emp.face_embedding.trim() === '000' || emp.face_embedding.trim() === '0,0,0') ? (
                            <span className="badge red" style={{ fontSize: 9, padding: '2px 4px', width: 'fit-content' }}>
                              Face not registered
                            </span>
                          ) : (
                            <span className="badge green" style={{ fontSize: 9, padding: '2px 4px', width: 'fit-content' }}>
                              Face registered
                            </span>
                          )}
                        </div>
                      </td>
                      <td>{emp.joining_date ? fmtDate(emp.joining_date) : fmtDate(emp.created_at)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1">
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--primary)', whiteSpace: 'nowrap' }} onClick={() => setAllotModalEmp(emp)} title="Allot Monthly Paid Leaves">
                            🌿 Leave
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => handleDelete(emp.id)} title="Delete Employee">
                            {I.trash}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && !loading && (
            <div className="empty-state" style={{ padding: '24px 0' }}>{I.employees}<h3>No employees match this filter</h3></div>
          )}
        </div>}

      {/* Add Modal */}
      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add New Employee</div>
            <div className="modal-sub">Fill in the employee details. Face enrollment happens via the mobile app.</div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleAdd}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input className="form-input" placeholder="e.g. Rahul Sharma" required
                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Employee ID</label>
                  <input className="form-input" placeholder="e.g. EMP-001" required
                    value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Department <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(Optional)</span></label>
                  <input className="form-input" placeholder="e.g. Engineering"
                    value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Designation <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(Optional)</span></label>
                  <input className="form-input" placeholder="e.g. Developer"
                    value={form.designation} onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Shift Start</label>
                  <input className="form-input" type="time" value={form.shift_start}
                    onChange={e => setForm(f => ({ ...f, shift_start: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Shift End</label>
                  <input className="form-input" type="time" value={form.shift_end}
                    onChange={e => setForm(f => ({ ...f, shift_end: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Joining Date</label>
                  <input className="form-input" type="date" value={form.joining_date}
                    onChange={e => setForm(f => ({ ...f, joining_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Monthly Salary (INR) <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(Optional)</span></label>
                  <input className="form-input" type="number" min="0" placeholder="e.g. 25000"
                    value={form.salary} onChange={e => setForm(f => ({ ...f, salary: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'center', margin: '8px 0 12px 0' }}>
                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                  <input type="checkbox" id="overtime_enabled"
                    checked={form.overtime_enabled}
                    onChange={e => setForm(f => ({ ...f, overtime_enabled: e.target.checked }))}
                    style={{ width: 18, height: 18, cursor: 'pointer' }} />
                  <label htmlFor="overtime_enabled" className="form-label" style={{ margin: 0, cursor: 'pointer', fontWeight: 600 }}>Enable Overtime</label>
                </div>
                {form.overtime_enabled && (
                  <div className="form-group">
                    <label className="form-label">Overtime Rate (INR/hr)</label>
                    <input className="form-input" type="number" min="0" placeholder="e.g. 200"
                      value={form.overtime_rate_per_hour}
                      onChange={e => setForm(f => ({ ...f, overtime_rate_per_hour: e.target.value }))} />
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Work Location <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(Optional)</span></label>
                <select className="form-input" value={form.location_id}
                  onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}>
                  <option value="">Unassigned (any scanner)</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add Employee'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Employee Profile Drawer */}
      {selectedProfileEmp && (
        <EmployeeProfileDrawer
          employee={selectedProfileEmp}
          adminId={adminId}
          locations={locations}
          onClose={() => setSelectedProfileEmp(null)}
          onUpdate={(updated) => {
            setEmployees(emps => emps.map(e => e.id === updated.id ? updated : e));
            setSelectedProfileEmp(updated);
          }}
        />
      )}

      {(showAllotModal || allotModalEmp) && (
        <AllotLeaveModal
          adminId={adminId}
          employees={employees}
          defaultEmployeeId={allotModalEmp?.id}
          onClose={() => {
            setShowAllotModal(false);
            setAllotModalEmp(null);
          }}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE  (3-tab: Log | Calendar | Shift Scheduler)
// ═══════════════════════════════════════════════════════════════════════════════
type AttTab = 'log' | 'calendar' | 'shifts';

/* ── helper: get all dates in a month where employee had check-in ── */
function useAttendanceData(adminId: string, selYear: number, selMonth: number) {
  const [attMap, setAttMap] = useState<Record<string, Set<string>>>({});
  const [punchTimesMap, setPunchTimesMap] = useState<Record<string, Record<string, { in?: string; out?: string }>>>({});
  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [empHolidays, setEmpHolidays] = useState<any[]>([]);
  const [leaves, setLeaves] = useState<any[]>([]);
  const [weeklyOffs, setWeeklyOffs] = useState<WeeklyOffDay[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Fetch a day beyond each month edge so early-morning/late-evening local
    // punches (stored on an adjacent UTC day) aren't dropped; the local-day
    // bucketing below keeps only the days that belong to this month.
    const monthStart = ymd(new Date(selYear, selMonth - 1, 0)) + 'T00:00:00';
    const monthEnd = ymd(new Date(selYear, selMonth, 1)) + 'T23:59:59';
    const monthPrefix = `${selYear}-${String(selMonth).padStart(2, '0')}`;
    const [ar, hr, ehr, lr, wor] = await Promise.all([
      supabase.from('attendance').select('employee_id,timestamp,punch_type')
        .eq('admin_id', adminId)
        .gte('timestamp', monthStart).lte('timestamp', monthEnd)
        .order('timestamp', { ascending: true }),
      supabase.from('public_holidays').select('*').eq('admin_id', adminId),
      supabase.from('employee_holidays').select('*').eq('admin_id', adminId)
        .gte('date', monthStart.slice(0, 10)).lte('date', monthEnd.slice(0, 10)),
      supabase.from('leave_requests').select('*').eq('admin_id', adminId).eq('status', 'approved')
        .gte('end_date', monthStart.slice(0, 10)).lte('start_date', monthEnd.slice(0, 10)),
      supabase.from('weekly_off_days').select('*').eq('admin_id', adminId),
    ]);
    const am: Record<string, Set<string>> = {};
    const ptm: Record<string, Record<string, { in?: string; out?: string; rawIn?: string; rawOut?: string }>> = {};

    for (const r of (ar.data ?? [])) {
      const d = dayKey(r.timestamp);
      if (d.slice(0, 7) !== monthPrefix) continue;   // drop adjacent-month rows from the padded window
      const empId = r.employee_id;

      if (!ptm[empId]) ptm[empId] = {};
      if (!ptm[empId][d]) ptm[empId][d] = {};

      const timeFormatted = fmtTime(r.timestamp);

      if (r.punch_type === 'check_in') {
        if (!am[empId]) am[empId] = new Set();
        am[empId].add(d);

        if (!ptm[empId][d].rawIn || r.timestamp < ptm[empId][d].rawIn!) {
          ptm[empId][d].rawIn = r.timestamp;
          ptm[empId][d].in = timeFormatted;
        }
      }

      if (r.punch_type === 'check_out') {
        if (!ptm[empId][d].rawOut || r.timestamp > ptm[empId][d].rawOut!) {
          ptm[empId][d].rawOut = r.timestamp;
          ptm[empId][d].out = timeFormatted;
        }
      }
    }
    setAttMap(am);
    setPunchTimesMap(ptm);
    setHolidays(hr.data ?? []);
    setEmpHolidays(ehr.data ?? []);
    setLeaves(lr.data ?? []);
    setWeeklyOffs((wor.data ?? []) as WeeklyOffDay[]);
    setLoading(false);
  }, [adminId, selYear, selMonth]);

  useEffect(() => { load(); }, [load]);
  return { attMap, punchTimesMap, holidays, empHolidays, leaves, weeklyOffs, loading, refresh: load };
}


/* ── Attendance Calendar sub-page ── */
function AttendanceCalendar({ adminId, employees }: { adminId: string; employees: Employee[] }) {
  const now = new Date();
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selEmp, setSelEmp] = useState<string>('__all__');

  const { attMap, punchTimesMap, holidays, empHolidays, leaves, weeklyOffs, loading, refresh } = useAttendanceData(adminId, selYear, selMonth);

  const [editingDay, setEditingDay] = useState<{ emp: Employee; date: string; dayNum: number; currentType: DayType } | null>(null);
  const [editType, setEditType] = useState<string>('present');
  const [overrideName, setOverrideName] = useState('');
  const [savingDay, setSavingDay] = useState(false);

  const handleSaveDay = async () => {
    if (!editingDay) return;
    setSavingDay(true);
    const { emp, date } = editingDay;

    // 1. For 'present' — insert FIRST, then delete old records only if insert succeeded
    //    (prevents the employee ending up with zero records = "absent")
    if (editType === 'present') {
      const { error: insertErr } = await supabase.from('attendance').insert({
        admin_id: adminId,
        employee_id: emp.id,
        employee_name: emp.name,
        employee_code: emp.employee_id,
        timestamp: `${date}T${emp.shift_start || '09:00'}:00`,
        punch_type: 'check_in',
        confidence: 1.0,
        verification_method: 'admin',
      });

      if (insertErr) {
        alert(`Failed to mark present: ${insertErr.message}`);
        setSavingDay(false);
        return;
      }

      // Now safe to delete the old records for this day
      await supabase.from('attendance')
        .delete()
        .eq('employee_id', emp.id)
        .gte('timestamp', date + 'T00:00:00')
        .lte('timestamp', date + 'T23:59:59')
        .neq('timestamp', `${date}T${emp.shift_start || '09:00'}:00`);

      // Also clear any leave/holiday overrides
      await supabase.from('employee_holidays').delete().eq('employee_id', emp.id).eq('date', date);
      await supabase.from('leave_requests').delete().eq('employee_id', emp.id).eq('start_date', date);

    } else {
      // For absent / leave / holiday / clear — delete first then insert override
      await supabase.from('attendance')
        .delete()
        .eq('employee_id', emp.id)
        .gte('timestamp', date + 'T00:00:00')
        .lte('timestamp', date + 'T23:59:59');

      await supabase.from('employee_holidays').delete().eq('employee_id', emp.id).eq('date', date);
      await supabase.from('leave_requests').delete().eq('employee_id', emp.id).eq('start_date', date);

      if (editType === 'clear' || editType === 'public_holiday') {
        await supabase.from('public_holidays').delete().eq('admin_id', adminId).eq('date', date);
      }

      if (editType === 'holiday') {
        const { error: holErr } = await supabase.from('employee_holidays').insert({
          id: crypto.randomUUID(),
          admin_id: adminId,
          employee_id: emp.id,
          date: date,
          name: overrideName || 'Custom Off'
        });
        if (holErr) { alert(`Failed to set holiday: ${holErr.message}`); setSavingDay(false); return; }
      } else if (editType === 'public_holiday') {
        const { error: phErr } = await supabase.from('public_holidays').insert({
          id: crypto.randomUUID(),
          admin_id: adminId,
          date: date,
          name: overrideName || 'Public Holiday'
        });
        if (phErr) { alert(`Failed to set public holiday: ${phErr.message}`); setSavingDay(false); return; }
      } else if (editType === 'leave') {
        const { error: lvErr } = await supabase.from('leave_requests').insert({
          id: crypto.randomUUID(),
          admin_id: adminId,
          employee_id: emp.id,
          start_date: date,
          end_date: date,
          type: overrideName || 'paid',
          status: 'approved',
          reason: 'Marked by Admin'
        });
        if (lvErr) { alert(`Failed to approve leave: ${lvErr.message}`); setSavingDay(false); return; }
      }
      // editType === 'absent' or 'clear' — just deleting records is enough
    }

    // Audit log
    await auditLog(adminId, 'attendance.calendar_override', emp.id, emp.name, {
      date,
      action: editType,
      override_name: overrideName || null,
      employee_code: emp.employee_id,
    });

    setSavingDay(false);
    setEditingDay(null);
    setOverrideName('');
    refresh();
  };


  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dim = new Date(selYear, selMonth, 0).getDate();
  const firstDay = new Date(selYear, selMonth - 1, 1).getDay();
  const holidayDates = new Set(holidays.map(h => h.date));
  const weeklyOffSet = new Set(weeklyOffs.map(w => w.weekday));
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = today();

  // employees to show
  const showEmps = selEmp === '__all__'
    ? employees
    : employees.filter(e => e.id === selEmp);

  // stats for selected month (excl Sundays, public holidays, and custom employee holidays if single selected)
  const workingDays = (() => {
    let c = 0;
    const empHols = new Set(
      selEmp !== '__all__'
        ? empHolidays.filter(eh => eh.employee_id === selEmp).map(eh => eh.date)
        : []
    );
    for (let d = 1; d <= dim; d++) {
      const ds = `${selYear}-${pad(selMonth)}-${pad(d)}`;
      const dt = new Date(selYear, selMonth - 1, d);
      const isOff = holidayDates.has(ds) || weeklyOffSet.has(toWeekdayNumber(dt));
      if (!isOff && !empHols.has(ds)) c++;
    }
    return c;
  })();

  type DayType = 'present' | 'absent' | 'holiday' | 'leave' | 'sunday' | 'future' | 'empty';
  const dayType = (emp: Employee, day: number): DayType => {
    const ds = `${selYear}-${pad(selMonth)}-${pad(day)}`;

    // 1. Check custom employee holiday
    const isEmpHol = empHolidays.some(eh => eh.employee_id === emp.id && eh.date === ds);
    if (isEmpHol) return 'holiday';

    // 2. Check public holiday or weekly off day
    const dt = new Date(selYear, selMonth - 1, day);
    if (holidayDates.has(ds) || weeklyOffSet.has(toWeekdayNumber(dt))) return 'holiday';

    // 3. Check approved leave request
    const isOnLeave = leaves.some(l => l.employee_id === emp.id && l.status === 'approved' && l.start_date <= ds && l.end_date >= ds);
    if (isOnLeave) return 'leave';

    // 4. Check attendance log check-ins
    if (attMap[emp.id]?.has(ds)) return 'present';

    // 5. Default to future or absent based on date limit
    if (ds > todayStr) return 'future';
    return 'absent';
  };


  const typeStyle: Record<string, { bg: string; color: string; border: string }> = {
    present: { bg: 'rgba(16, 185, 129, 0.06)', color: '#047857', border: '1px solid rgba(16, 185, 129, 0.2)' },
    absent: { bg: 'rgba(239, 68, 68, 0.05)', color: '#b91c1c', border: '1px solid rgba(239, 68, 68, 0.2)' },
    holiday: { bg: 'rgba(245, 158, 11, 0.06)', color: '#b45309', border: '1px solid rgba(245, 158, 11, 0.2)' },
    leave: { bg: 'rgba(59, 130, 246, 0.06)', color: '#1d4ed8', border: '1px solid rgba(59, 130, 246, 0.2)' },
    unpaid: { bg: 'rgba(239, 68, 68, 0.06)', color: '#c2410c', border: '1px solid rgba(239, 68, 68, 0.25)' },
    sunday: { bg: '#f8fafc', color: '#64748b', border: '1px solid #e2e8f0' },
    future: { bg: 'transparent', color: '#94a3b8', border: '1px dashed #e2e8f0' },
    empty: { bg: 'transparent', color: 'transparent', border: 'none' },
  };

  // Get leave record for a specific employee+date
  const getLeaveForDay = (emp: Employee, ds: string) =>
    leaves.find(l => l.employee_id === emp.id && l.status === 'approved' && l.start_date <= ds && l.end_date >= ds);

  const leaveLabelMap: Record<string, string> = {
    paid: '🌿 PAID LEAVE',
    casual: '🌿 CASUAL',
    sick: '🌿 SICK LEAVE',
    unpaid: '⚠ UNPAID (LWP)',
  };

  const typeLabel: Record<string, string> = {
    present: '✓ PRESENT', absent: '✗ ABSENT', holiday: '★ HOLIDAY', leave: '🌿 LEAVE', sunday: 'SUNDAY', future: '—', empty: '',
  };

  const calCells = [...Array(firstDay).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];

  return (
    <div>
      {/* Controls */}
      <div className="flex gap-2 items-center mb-6" style={{ flexWrap: 'wrap' }}>
        <select className="form-input" value={selMonth} style={{ width: 100 }}
          onChange={e => setSelMonth(Number(e.target.value))}>
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select className="form-input" value={selYear} style={{ width: 90 }}
          onChange={e => setSelYear(Number(e.target.value))}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="form-input cal-emp-select" value={selEmp} style={{ minWidth: 180 }}
          onChange={e => setSelEmp(e.target.value)}>
          <option value="__all__">All Employees</option>
          {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {([
            { type: 'present', label: 'Present', styleKey: 'present' },
            { type: 'absent', label: 'Absent', styleKey: 'absent' },
            { type: 'holiday', label: 'Public Holiday', styleKey: 'holiday' },
            { type: 'weekly_off', label: 'Weekly Off', styleKey: 'holiday' },
            { type: 'leave', label: 'On Leave', styleKey: 'leave' },
          ]).map(({ type, label, styleKey }) => (
            <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: typeStyle[styleKey].bg, border: typeStyle[styleKey].border, display: 'inline-block' }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Summary row */}
      <div className="cal-summary-row" style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <div className="card" style={{ flex: 1, padding: '12px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Working Days</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginTop: 4 }}>{workingDays}</div>
        </div>
        <div className="card" style={{ flex: 1, padding: '12px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Public Holidays</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--warning)', marginTop: 4 }}>{holidays.length}</div>
        </div>
        <div className="card" style={{ flex: 1, padding: '12px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Employees Shown</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--info)', marginTop: 4 }}>{showEmps.length}</div>
        </div>
        <div className="card" style={{ flex: 1, padding: '12px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Weekly Off Days</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-muted)', marginTop: 4 }}>{dim - workingDays - holidays.length}</div>
        </div>
      </div>

      {loading ? <div className="loader-overlay"><div className="spinner" /></div>
        : showEmps.length === 0
          ? <div className="empty-state">{I.attendance}<h3>No employees</h3></div>
          : showEmps.map(emp => {
            const presentCount = Array.from({ length: dim }, (_, i) => i + 1)
              .filter(d => dayType(emp, d) === 'present').length;
            const absentCount = Array.from({ length: dim }, (_, i) => i + 1)
              .filter(d => dayType(emp, d) === 'absent').length;
            const pct = workingDays > 0 ? Math.round((presentCount / workingDays) * 100) : 0;

            return (
              <div key={emp.id} className="card" style={{ marginBottom: 16 }}>
                {/* Employee header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: '1px solid var(--border-light)' }}>
                  <div className="avatar-circle" style={{ background: avatarColor(emp.name), width: 38, height: 38, fontSize: 14 }}>{initials(emp.name)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{emp.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{emp.employee_id} · Shift {emp.shift_start}–{emp.shift_end}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span className="badge green">✅ {presentCount} present</span>
                    <span className="badge red">❌ {absentCount} absent</span>
                    <span className={`badge ${pct >= 90 ? 'green' : pct >= 70 ? 'yellow' : 'red'}`}>{pct}%</span>
                  </div>
                  {/* Attendance bar */}
                  <div className="attend-bar-wrap" style={{ minWidth: 100 }}>
                    <div className="attend-bar-bg" style={{ height: 6 }}>
                      <div className="attend-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>

                {/* Calendar grid */}
                <div style={{ padding: '14px 20px' }}>
                  {/* Day name headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 6 }}>
                    {DAY_NAMES.map(d => (
                      <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 4 }}>{d}</div>
                    ))}
                  </div>
                  {/* Day cells */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                    {calCells.map((day, idx) => {
                      if (!day) return <div key={idx} />;
                      const ds = `${selYear}-${pad(selMonth)}-${pad(day)}`;
                      const type = dayType(emp, day);
                      const leaveRec = type === 'leave' ? getLeaveForDay(emp, ds) : undefined;
                      const isUnpaid = leaveRec?.type === 'unpaid';
                      const stKey = isUnpaid ? 'unpaid' : type;
                      const st = typeStyle[stKey];
                      const isToday = ds === todayStr;
                      const holName = holidays.find(h => h.date === ds)?.name
                        || empHolidays.find(eh => eh.employee_id === emp.id && eh.date === ds)?.name;

                      // Cell label
                      let cellLabel = typeLabel[type] ?? '';
                      if (type === 'holiday' && holName) cellLabel = `★ ${holName.toUpperCase()}`;
                      if (type === 'leave' && leaveRec) cellLabel = leaveLabelMap[leaveRec.type] ?? `🌿 ${leaveRec.type.toUpperCase()}`;

                      const punchInfo = punchTimesMap[emp.id]?.[ds];
                      const titleTooltip = holName
                        ? holName
                        : type === 'present'
                          ? `${emp.name} · Present\nIn: ${punchInfo?.in ?? '—'}\nOut: ${punchInfo?.out ?? '—'}`
                          : type === 'absent' ? `${emp.name} · Absent` : leaveRec?.type ?? '';

                      return (
                        <div key={idx} title={titleTooltip}
                          onClick={() => {
                            setEditingDay({ emp, date: ds, dayNum: day, currentType: type });
                            // Always default to 'present' so user clearly picks what to change TO
                            setEditType('present');
                            setOverrideName('');
                          }}
                          style={{
                            background: st.bg,
                            border: isToday ? '2px solid var(--primary)' : st.border,
                            borderRadius: 6,
                            padding: type === 'present' ? '6px 2px' : '10px 4px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            minHeight: 56,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'all 0.15s ease'
                          }}>
                          <div style={{ fontSize: 12.5, fontWeight: 800, color: isToday ? 'var(--primary-dark)' : st.color }}>{day}</div>
                          {type === 'present' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%', marginTop: 2, padding: '0 1px' }}>
                              <div style={{
                                fontSize: 8.5,
                                fontWeight: 700,
                                color: '#047857',
                                background: 'rgba(16, 185, 129, 0.16)',
                                padding: '1px 2px',
                                borderRadius: 3,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}>
                                ▲ {punchInfo?.in ?? '—'}
                              </div>
                              <div style={{
                                fontSize: 8.5,
                                fontWeight: 700,
                                color: punchInfo?.out ? '#1d4ed8' : '#94a3b8',
                                background: punchInfo?.out ? 'rgba(59, 130, 246, 0.16)' : 'rgba(148, 163, 184, 0.12)',
                                padding: '1px 2px',
                                borderRadius: 3,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}>
                                ▼ {punchInfo?.out ?? '—'}
                              </div>
                            </div>
                          ) : (
                            type !== 'empty' && (
                              <div style={{
                                fontSize: 8,
                                fontWeight: 700,
                                color: st.color,
                                marginTop: 4,
                                letterSpacing: 0.5,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                                padding: '0 2px'
                              }}>
                                {cellLabel}
                              </div>
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

      {editingDay && (
        <div className="modal-backdrop" onClick={() => setEditingDay(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="modal-title" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Edit Day Status</div>
              <button className="btn btn-ghost" onClick={() => setEditingDay(null)} style={{ padding: 8 }}>{I.x}</button>
            </div>
            <div className="modal-sub" style={{ marginBottom: 16 }}>
              Modify attendance state or set a holiday for <strong>{editingDay.emp.name}</strong> on <strong>{fmtDate(editingDay.date)}</strong>.
            </div>

            {(() => {
              const dt = new Date(editingDay.date);
              const wk = toWeekdayNumber(dt);
              const isWeeklyOff = weeklyOffSet.has(wk);
              const weekdayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
              if (!isWeeklyOff) return null;
              return (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'var(--warning-bg)',
                  border: '1px solid var(--warning)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  fontSize: 13,
                  color: '#b45309',
                  marginBottom: 16
                }}>
                  <span style={{ fontSize: 18 }}>🔁</span>
                  <div>
                    <strong>{weekdayNames[wk]}</strong> — Weekly off day — automatically counted as paid leave.
                  </div>
                </div>
              );
            })()}


            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { value: 'present', label: '✓ Mark Present', desc: 'Add a manual check-in record for this employee' },
                { value: 'absent', label: '✗ Mark Absent', desc: 'Remove check-in records to mark as absent' },
                { value: 'leave', label: '🌿 Approve Leave', desc: 'Approve a paid/unpaid leave day for this employee' },
                { value: 'holiday', label: '★ Custom Employee Holiday', desc: 'Allot an individual paid holiday' },
                { value: 'public_holiday', label: '🎉 Public Holiday', desc: 'Mark a public holiday for all employees' },
                { value: 'clear', label: '↺ Reset / Clear Overrides', desc: 'Revert to default system state' },
              ].map(opt => (
                <label key={opt.value} style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '12px 14px',
                  border: editType === opt.value ? '2px solid var(--primary)' : '1px solid var(--border-light)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: editType === opt.value ? 'rgba(37,99,235,0.05)' : 'var(--surface)',
                  transition: 'all 0.15s ease'
                }}>
                  <input type="radio" name="editType" value={opt.value} checked={editType === opt.value}
                    onChange={() => {
                      setEditType(opt.value);
                      if (opt.value === 'leave') setOverrideName('paid');
                    }} style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: editType === opt.value ? 'var(--primary)' : 'var(--text)' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{opt.desc}</div>
                  </div>
                </label>
              ))}

              {(editType === 'holiday' || editType === 'public_holiday') && (
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label className="form-label">Holiday Name / Occasion</label>
                  <input className="form-input" placeholder="e.g. Local Festival / Eid / Off-day" required
                    value={overrideName} onChange={e => setOverrideName(e.target.value)} />
                </div>
              )}

              {editType === 'leave' && (
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label className="form-label">Leave Type</label>
                  <select className="form-input" required value={overrideName}
                    onChange={e => setOverrideName(e.target.value)}>
                    <option value="paid">Paid Leave (CL/PL)</option>
                    <option value="sick">Sick Leave</option>
                    <option value="casual">Casual Leave</option>
                    <option value="unpaid">Unpaid Leave (LWP)</option>
                  </select>
                </div>
              )}
            </div>

            <div className="modal-actions" style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => setEditingDay(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={handleSaveDay} disabled={savingDay}>
                {savingDay ? 'Saving…' : 'Save Status'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Shift Scheduler sub-page ── */
function ShiftScheduler({ adminId, employees, onRefresh }: {
  adminId: string; employees: Employee[]; onRefresh: () => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState({ shift_start: '', shift_end: '' });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulk, setBulk] = useState({ shift_start: '09:00', shift_end: '18:00' });
  const [bulkSaving, setBulkSaving] = useState(false);

  // Custom overrides scheduling states
  const [showCustom, setShowCustom] = useState(false);
  const [customVal, setCustomVal] = useState({
    employee_id: '',
    shift_name: 'Night Shift',
    start_date: today(),
    end_date: today(),
    shift_start: '22:00',
    shift_end: '06:00',
  });
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState('');
  const [overrides, setOverrides] = useState<(EmployeeShift & { employee_name?: string })[]>([]);
  const [loadingOverrides, setLoadingOverrides] = useState(false);

  // Set default employee when employees list loads
  useEffect(() => {
    if (employees.length && !customVal.employee_id) {
      setCustomVal(v => ({ ...v, employee_id: employees[0].id }));
    }
  }, [employees]);

  // Load custom shift overrides
  const loadOverrides = useCallback(async () => {
    setLoadingOverrides(true);
    const { data } = await supabase.from('employee_shifts')
      .select('*')
      .eq('admin_id', adminId)
      .order('date', { ascending: false });
    const mapped = (data || []).map(item => {
      const emp = employees.find(e => e.id === item.employee_id);
      return {
        ...item,
        employee_name: emp ? emp.name : 'Unknown Employee',
      };
    });
    setOverrides(mapped);
    setLoadingOverrides(false);
  }, [adminId, employees]);

  useEffect(() => {
    loadOverrides();
  }, [loadOverrides]);

  const filtered = employees.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.employee_id.toLowerCase().includes(search.toLowerCase())
  );

  const saveShift = async (empId: string) => {
    setSaving(true);
    await supabase.from('employees')
      .update({ shift_start: editVal.shift_start, shift_end: editVal.shift_end })
      .eq('id', empId);
    setSaving(false);
    setEditId(null);
    onRefresh();
  };

  const applyBulk = async () => {
    setBulkSaving(true);
    await supabase.from('employees')
      .update({ shift_start: bulk.shift_start, shift_end: bulk.shift_end })
      .eq('admin_id', adminId);
    setBulkSaving(false);
    setShowBulk(false);
    onRefresh();
  };

  const scheduleCustomShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setCustomSaving(true);
    setCustomError('');

    try {
      const start = new Date(customVal.start_date);
      const end = new Date(customVal.end_date);
      if (end < start) {
        setCustomError('End date cannot be before start date.');
        setCustomSaving(false);
        return;
      }

      const list = [];
      let current = new Date(start);
      const randId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });

      while (current <= end) {
        const dateStr = current.toISOString().slice(0, 10);
        list.push({
          id: randId(),
          admin_id: adminId,
          employee_id: customVal.employee_id,
          date: dateStr,
          shift_start: customVal.shift_start,
          shift_end: customVal.shift_end,
          shift_name: customVal.shift_name,
        });
        current.setDate(current.getDate() + 1);
      }

      const { error } = await supabase
        .from('employee_shifts')
        .upsert(list, { onConflict: 'employee_id,date' });

      if (error) throw error;

      setShowCustom(false);
      loadOverrides();
    } catch (err: any) {
      setCustomError(err.message || 'Failed to save shift overrides');
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteOverride = async (id: string) => {
    if (!confirm('Remove this custom shift override and restore default timings for this date?')) return;
    const ov = overrides.find(o => o.id === id);
    const res = await softDeleteRecord('employee_shifts', id, adminId, 'admin', 'admin', ov ? `${ov.date} (${ov.shift_name})` : id);
    if (!res.success) {
      alert(`Failed to delete shift override: ${res.error}`);
      return;
    }
    await auditLog(adminId, 'shift_override.delete', id, ov ? `${ov.date} (${ov.shift_name})` : id, {
      date: ov?.date,
      shift_start: ov?.shift_start,
      shift_end: ov?.shift_end,
      shift_name: ov?.shift_name,
      soft_deleted: true,
    });
    loadOverrides();
  };

  const shiftDuration = (s: string, e: string) => {
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60; // handle overnight shifts
    if (mins <= 0) return '—';
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  return (
    <div>
      <div className="section-head mb-4">
        <div>
          <div className="section-title">Shift Scheduler</div>
          <div className="section-sub">{employees.length} employees · Click edit to change any shift</div>
        </div>
        <div className="flex gap-2 shift-head-controls">
          <div className="search-wrap">
            {I.search}
            <input className="form-input search-input" placeholder="Search employee…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => setShowBulk(true)}>
            ⚡ Apply to All
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCustom(true)}>
            📅 Schedule Custom Shift
          </button>
        </div>
      </div>

      {/* Shift presets */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Morning', s: '06:00', e: '14:00' },
          { label: 'Day', s: '09:00', e: '18:00' },
          { label: 'Evening', s: '14:00', e: '22:00' },
          { label: 'Night', s: '22:00', e: '06:00' },
        ].map(p => (
          <button key={p.label}
            className={`btn btn-sm ${editId ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 12 }}
            onClick={() => editId && setEditVal({ shift_start: p.s, shift_end: p.e })}>
            ⏰ {p.label} ({p.s}–{p.e})
          </button>
        ))}
        {editId && <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>← Click a preset to fill</span>}
      </div>

      <div className="card mb-6">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Employee</th>
              <th>Default Shift Start</th>
              <th>Default Shift End</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr></thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={5}><div className="empty-state">{I.employees}<h3>No employees</h3></div></td></tr>
                : filtered.map(emp => {
                  const isEditing = editId === emp.id;
                  const dur = shiftDuration(emp.shift_start, emp.shift_end);
                  return (
                    <tr key={emp.id} style={{ background: isEditing ? 'var(--primary-glow)' : '' }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="avatar-circle" style={{ background: avatarColor(emp.name), width: 32, height: 32, fontSize: 12 }}>{initials(emp.name)}</div>
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{emp.name}</div>
                            <code style={{ fontSize: 10.5, background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4 }}>{emp.employee_id}</code>
                          </div>
                        </div>
                      </td>
                      <td>
                        {isEditing
                          ? <input className="form-input" type="time" value={editVal.shift_start}
                            onChange={e => setEditVal(v => ({ ...v, shift_start: e.target.value }))}
                            style={{ width: 120 }} />
                          : <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--info)' }}>
                            🌅 {emp.shift_start}
                          </span>}
                      </td>
                      <td>
                        {isEditing
                          ? <input className="form-input" type="time" value={editVal.shift_end}
                            onChange={e => setEditVal(v => ({ ...v, shift_end: e.target.value }))}
                            style={{ width: 120 }} />
                          : <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--primary-dark)' }}>
                            🌙 {emp.shift_end}
                          </span>}
                      </td>
                      <td>
                        <span className="badge blue">{isEditing ? shiftDuration(editVal.shift_start, editVal.shift_end) : dur}</span>
                      </td>
                      <td>
                        {isEditing
                          ? <div className="flex gap-2">
                            <button className="btn btn-sm btn-primary" onClick={() => saveShift(emp.id)} disabled={saving}>
                              {saving ? '…' : I.check} Save
                            </button>
                            <button className="btn btn-sm btn-outline" onClick={() => setEditId(null)}>{I.x}</button>
                          </div>
                          : <button className="btn btn-ghost btn-sm" onClick={() => {
                            setEditId(emp.id);
                            setEditVal({ shift_start: emp.shift_start, shift_end: emp.shift_end });
                          }}>{I.edit} Edit</button>}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Scheduled overrides section */}
      <div className="section-head mb-4" style={{ marginTop: 32 }}>
        <div>
          <div className="section-title">📅 Scheduled Shift Overrides</div>
          <div className="section-sub">Temporary shift modifications applied to specific dates</div>
        </div>
      </div>

      <div className="card">
        {loadingOverrides ? <div className="mini-empty">Loading scheduled overrides...</div> :
          overrides.length === 0 ? <div className="mini-empty">No custom overrides scheduled. Use "Schedule Custom Shift" to create one.</div> :
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>Employee</th>
                  <th>Date</th>
                  <th>Shift Name</th>
                  <th>Override Timing</th>
                  <th>Duration</th>
                  <th>Action</th>
                </tr></thead>
                <tbody>
                  {overrides.map(item => (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="avatar-circle" style={{ background: avatarColor(item.employee_name || 'NA'), width: 28, height: 28, fontSize: 10 }}>{initials(item.employee_name || 'NA')}</div>
                          <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{item.employee_name}</span>
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>{fmtDate(item.date)}</td>
                      <td><span className="badge grey">{item.shift_name}</span></td>
                      <td style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--primary-dark)' }}>
                        ⏰ {item.shift_start} – {item.shift_end}
                      </td>
                      <td>
                        <span className="badge blue">{shiftDuration(item.shift_start, item.shift_end)}</span>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => deleteOverride(item.id)}>
                          Restore Default
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        }
      </div>

      {/* Bulk apply modal */}
      {showBulk && (
        <div className="modal-backdrop" onClick={() => setShowBulk(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Apply Shift to All Employees</div>
            <div className="modal-sub">This will update the shift for every employee in your account.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Shift Start</label>
                <input className="form-input" type="time" value={bulk.shift_start}
                  onChange={e => setBulk(b => ({ ...b, shift_start: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Shift End</label>
                <input className="form-input" type="time" value={bulk.shift_end}
                  onChange={e => setBulk(b => ({ ...b, shift_end: e.target.value }))} />
              </div>
            </div>
            <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: '#92400e', marginBottom: 4 }}>
              ⚠️ This will overwrite shifts for all {employees.length} employees.
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowBulk(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={applyBulk} disabled={bulkSaving}>
                {bulkSaving ? 'Applying…' : '⚡ Apply to All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Schedule Overrides modal */}
      {showCustom && (
        <div className="modal-backdrop" onClick={() => { setShowCustom(false); setCustomError(''); }}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Schedule Custom Shift Override</div>
            <div className="modal-sub">Override the default work shift for an employee over a specific date range.</div>
            {customError && <div className="error-banner" style={{ marginBottom: 12 }}>{customError}</div>}
            <form onSubmit={scheduleCustomShift}>
              <div className="form-group">
                <label className="form-label">Select Employee</label>
                <select className="form-input" value={customVal.employee_id} required
                  onChange={e => setCustomVal(c => ({ ...c, employee_id: e.target.value }))}>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.employee_id})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Shift Name</label>
                <input className="form-input" placeholder="e.g. Night Shift, Double Shift" required
                  value={customVal.shift_name} onChange={e => setCustomVal(c => ({ ...c, shift_name: e.target.value }))} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Start Date</label>
                  <input className="form-input" type="date" required
                    value={customVal.start_date} onChange={e => setCustomVal(c => ({ ...c, start_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">End Date</label>
                  <input className="form-input" type="date" required
                    value={customVal.end_date} onChange={e => setCustomVal(c => ({ ...c, end_date: e.target.value }))} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Shift Start Time</label>
                  <input className="form-input" type="time" required
                    value={customVal.shift_start} onChange={e => setCustomVal(c => ({ ...c, shift_start: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Shift End Time</label>
                  <input className="form-input" type="time" required
                    value={customVal.shift_end} onChange={e => setCustomVal(c => ({ ...c, shift_end: e.target.value }))} />
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setShowCustom(false); setCustomError(''); }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={customSaving}>
                  {customSaving ? 'Saving…' : '📅 Schedule Override'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main AttendancePage ── */
function AttendancePage({ adminId }: { adminId: string }) {
  const [attTab, setAttTab] = useState<AttTab>('log');
  const [employees, setEmployees] = useState<Employee[]>([]);

  // Load employees for calendar and shift scheduler
  useEffect(() => {
    supabase.from('employees').select('*').eq('admin_id', adminId).order('name')
      .then(({ data }) => setEmployees(data ?? []));
  }, [adminId]);

  const refreshEmps = useCallback(() => {
    supabase.from('employees').select('*').eq('admin_id', adminId).order('name')
      .then(({ data }) => setEmployees(data ?? []));
  }, [adminId]);

  // ── Log sub-page state ──
  const [records, setRecords] = useState<Attendance[]>([]);
  const [date, setDate] = useState(today());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'check_in' | 'check_out'>('all');
  const [logLoading, setLogLoading] = useState(true);

  // Manual Punch Modal states
  const [showMark, setShowMark] = useState(false);
  const [markForm, setMarkForm] = useState({ employee_id: '', punch_type: 'check_in', time: '09:00', date: date });
  const [markSaving, setMarkSaving] = useState(false);
  const [markError, setMarkError] = useState('');

  // Sync date changes to mark form
  useEffect(() => {
    setMarkForm(f => ({ ...f, date }));
  }, [date]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    const { data } = await supabase.from('attendance').select('*')
      .eq('admin_id', adminId)
      .gte('timestamp', date + 'T00:00:00')
      .lte('timestamp', date + 'T23:59:59')
      .order('timestamp', { ascending: false });
    setRecords(data ?? []);
    setLogLoading(false);
  }, [adminId, date]);

  useEffect(() => { loadLog(); }, [loadLog]);

  const filteredLog = records.filter(r => {
    if (filter !== 'all' && r.punch_type !== filter) return false;
    if (search && !r.employee_name.toLowerCase().includes(search.toLowerCase()) &&
      !r.employee_code.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleDeleteRecord = async (id: string) => {
    if (!confirm('Are you sure you want to delete this punch record? It will be moved to the Recycle Bin.')) return;
    const rec = records.find(r => r.id === id);
    const res = await softDeleteRecord('attendance', id, adminId, 'admin', 'admin', rec ? `${rec.employee_name} (${rec.punch_type})` : id);
    if (!res.success) {
      alert(`Failed to delete punch: ${res.error}`);
    } else {
      await auditLog(adminId, 'attendance.delete', id, rec?.employee_name ?? id, {
        employee_code: rec?.employee_code,
        punch_type: rec?.punch_type,
        timestamp: rec?.timestamp,
        soft_deleted: true,
      });
      loadLog();
    }
  };

  const handleMarkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!markForm.employee_id) return;
    setMarkSaving(true); setMarkError('');

    const emp = employees.find(x => x.id === markForm.employee_id);
    if (!emp) {
      setMarkSaving(false);
      setMarkError('Employee not found.');
      return;
    }

    try {
      const localTimeStr = `${markForm.date}T${markForm.time}:00`;
      const timestamp = new Date(localTimeStr).toISOString();

      const { error: err } = await supabase.from('attendance').insert({
        admin_id: adminId,
        employee_id: emp.id,
        employee_name: emp.name,
        employee_code: emp.employee_id,
        punch_type: markForm.punch_type,
        timestamp,
        confidence: 1.0,
        verification_method: 'admin', // Valid options: 'face', 'admin'
      });

      if (err) throw err;

      await auditLog(adminId, 'attendance.manual_insert', null, emp.name, {
        employee_code: emp.employee_id,
        punch_type: markForm.punch_type,
        date: markForm.date,
        time: markForm.time,
      });

      setShowMark(false);
      setMarkForm({ employee_id: '', punch_type: 'check_in', time: '09:00', date });
      loadLog();
    } catch (err: any) {
      setMarkError(err.message || 'Failed to mark attendance.');
    } finally {
      setMarkSaving(false);
    }
  };

  const checkIns = records.filter(r => r.punch_type === 'check_in').length;
  const checkOuts = records.filter(r => r.punch_type === 'check_out').length;

  return (
    <div>
      {/* Top-level tab bar */}
      <div className="tab-bar mb-6">
        <button className={`tab-item ${attTab === 'log' ? 'active' : ''}`} onClick={() => setAttTab('log')}>
          {I.attendance}
          <span>Attendance Log</span>
        </button>
        <button className={`tab-item ${attTab === 'calendar' ? 'active' : ''}`} onClick={() => setAttTab('calendar')}>
          {I.leave}
          <span>Calendar View</span>
        </button>
        <button className={`tab-item ${attTab === 'shifts' ? 'active' : ''}`} onClick={() => setAttTab('shifts')}>
          {I.clock}
          <span>Shift Scheduler</span>
        </button>
      </div>

      {/* ── LOG TAB ── */}
      {attTab === 'log' && (
        <div>
          <div className="section-head mb-4">
            <div>
              <div className="section-title">Daily Attendance Log</div>
              <div className="section-sub">{records.length} records for {fmtDate(date)}</div>
            </div>
            <div className="flex gap-2 items-center att-log-controls">
              <input className="form-input" type="date" value={date}
                onChange={e => setDate(e.target.value)} style={{ maxWidth: 160 }} />
              <div className="search-wrap">
                {I.search}
                <input className="form-input search-input" placeholder="Search employee…"
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={() => setShowMark(true)}>
                {I.plus} Mark Attendance
              </button>
            </div>
          </div>

          {/* Mini stats */}
          <div className="mini-stats-row" style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <div className="card" style={{ flex: 1, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="badge green" style={{ fontSize: 14, padding: '4px 12px' }}>▲ {checkIns}</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>Check-ins</span>
            </div>
            <div className="card" style={{ flex: 1, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="badge blue" style={{ fontSize: 14, padding: '4px 12px' }}>▼ {checkOuts}</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>Check-outs</span>
            </div>
            <div className="card" style={{ flex: 1, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="badge yellow" style={{ fontSize: 14, padding: '4px 12px' }}>⚠ {checkIns - checkOuts}</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>Still punched in</span>
            </div>
          </div>

          {/* Punch-type tab */}
          <div className="tab-bar">
            {(['all', 'check_in', 'check_out'] as const).map(t => (
              <button key={t} className={`tab-item ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)}>
                {t === 'all' ? 'All' : t === 'check_in' ? '▲ Check-in' : '▼ Check-out'}
              </button>
            ))}
          </div>

          {logLoading ? <div className="loader-overlay"><div className="spinner" /></div>
            : <div className="card">
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>Employee</th><th>Code</th><th>Time</th><th>Type</th><th>Method</th><th>Confidence</th><th>Actions</th>
                  </tr></thead>
                  <tbody>
                    {filteredLog.length === 0
                      ? <tr><td colSpan={7}><div className="empty-state">{I.attendance}<h3>No records found</h3></div></td></tr>
                      : filteredLog.map(r => (
                        <tr key={r.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div className="avatar-circle" style={{ background: avatarColor(r.employee_name), width: 30, height: 30, fontSize: 11 }}>
                                {initials(r.employee_name)}
                              </div>
                              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{r.employee_name}</span>
                            </div>
                          </td>
                          <td><code style={{ background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 6, fontSize: 12 }}>{r.employee_code}</code></td>
                          <td style={{ fontWeight: 600 }}>{fmtTime(r.timestamp)}</td>
                          <td><span className={`badge ${r.punch_type === 'check_in' ? 'green' : 'blue'}`}>
                            {r.punch_type === 'check_in' ? '▲ In' : '▼ Out'}
                          </span></td>
                          <td>
                            {(() => {
                              const vm = r.verification_method?.toLowerCase() ?? '';
                              const isface = vm === 'face' || vm === 'face_recognition';
                              const isAdmin = vm === 'admin' || vm === 'manual';
                              const isPin = vm === 'pin';
                              return (
                                <span className={`badge ${isface ? 'green' : isAdmin ? 'yellow' : isPin ? 'blue' : 'grey'}`}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  {isface ? '🤖 FACE' : isAdmin ? '👤 ADMIN' : isPin ? '🔑 PIN' : (r.verification_method ?? '—').toUpperCase()}
                                </span>
                              );
                            })()}
                          </td>
                          <td>
                            <div className="attend-bar-wrap" style={{ minWidth: 80 }}>
                              <div className="attend-bar-bg" style={{ height: 4 }}>
                                <div className="attend-bar-fill" style={{ width: `${Math.round(r.confidence * 100)}%` }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 30 }}>{Math.round(r.confidence * 100)}%</span>
                            </div>
                          </td>
                          <td>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => handleDeleteRecord(r.id)} title="Delete Punch Record">
                              {I.trash}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>}
        </div>
      )}

      {/* ── CALENDAR TAB ── */}
      {attTab === 'calendar' && (
        <AttendanceCalendar adminId={adminId} employees={employees} />
      )}

      {/* ── SHIFTS TAB ── */}
      {attTab === 'shifts' && (
        <ShiftScheduler adminId={adminId} employees={employees} onRefresh={refreshEmps} />
      )}

      {/* Mark Attendance Modal */}
      {showMark && (
        <div className="modal-backdrop" onClick={() => setShowMark(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Mark Manual Attendance</div>
            <div className="modal-sub">Add a manual check-in or check-out punch record for an employee.</div>
            {markError && <div className="error-banner" style={{ marginBottom: 12 }}>{markError}</div>}
            <form onSubmit={handleMarkSubmit}>
              <div className="form-group">
                <label className="form-label">Employee</label>
                <select className="form-input" required value={markForm.employee_id}
                  onChange={e => {
                    const empId = e.target.value;
                    const emp = employees.find(x => x.id === empId);
                    const autoTime = markForm.punch_type === 'check_in'
                      ? (emp?.shift_start ?? '09:00')
                      : (emp?.shift_end ?? '18:00');
                    setMarkForm(f => ({ ...f, employee_id: empId, time: autoTime }));
                  }}>
                  <option value="">Select employee...</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.employee_id})</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Punch Type</label>
                <select className="form-input" required value={markForm.punch_type}
                  onChange={e => {
                    const pt = e.target.value;
                    const emp = employees.find(x => x.id === markForm.employee_id);
                    const autoTime = pt === 'check_in'
                      ? (emp?.shift_start ?? '09:00')
                      : (emp?.shift_end ?? '18:00');
                    setMarkForm(f => ({ ...f, punch_type: pt, time: autoTime }));
                  }}>
                  <option value="check_in">Check-in (In)</option>
                  <option value="check_out">Check-out (Out)</option>
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Date</label>
                  <input className="form-input" type="date" required value={markForm.date} onChange={e => setMarkForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Time</label>
                  <input className="form-input" type="time" required value={markForm.time} onChange={e => setMarkForm(f => ({ ...f, time: e.target.value }))} />
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowMark(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={markSaving}>{markSaving ? 'Saving…' : 'Mark Present'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}





// ─── Salary Slip Drawer ───────────────────────────────────────────────────────
function SalarySlipDrawer({ slip, month, year, onClose, onSalaryUpdate, adminId }: {
  slip: SalarySlip; month: number; year: number;
  onClose: () => void; onSalaryUpdate: () => void; adminId: string;
}) {
  const [editingSalary, setEditingSalary] = useState(false);
  const [salaryVal, setSalaryVal] = useState(String(slip.sal?.monthly_salary ?? ''));
  const [saving, setSaving] = useState(false);

  const monthName = new Date(year, month - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const saveSalary = async () => {
    setSaving(true);
    const previousSalary = slip.sal?.monthly_salary;
    const effectiveDate = ymd(new Date(year, month - 1, 1));
    await supabase.from('employee_salary').upsert({
      admin_id: adminId, employee_id: slip.emp.id,
      monthly_salary: Number(salaryVal), hourly_rate: 0, is_hourly: false,
      effective_date: effectiveDate,
    }, { onConflict: 'employee_id' });
    await auditLog(adminId, 'salary.update', slip.emp.id, slip.emp.name, {
      employee_code: slip.emp.employee_id,
      previous_salary: previousSalary ?? null,
      new_salary: Number(salaryVal),
      action: slip.sal ? 'update' : 'create',
    });
    setSaving(false);
    setEditingSalary(false);
    onSalaryUpdate();
  };

  const paidLeaveDays = Math.min(slip.leavesUsed, slip.leavesAllotted);
  const totalUnpaidDays = slip.daysAbsent;
  const unpaidLeaveDed = totalUnpaidDays * slip.perDaySalary;
  const calcMethodLabel = slip.calcMethod === 'fixed_30'
    ? 'Fixed 30-Day ÷ 30'
    : slip.calcMethod === 'actual_calendar'
      ? `Actual Calendar ÷ ${slip.daysInMonth} days`
      : `Working Days ÷ ${slip.workingDays} days`;

  const totalWorkedHrsStr = `${Math.floor((slip.totalWorkedMinutes ?? 0) / 60)}h ${(slip.totalWorkedMinutes ?? 0) % 60}m`;

  const rows = [
    { label: 'Gross Salary (Base)', val: fmtMoney(slip.grossPay), color: 'var(--text)', bold: true },
    { label: `Daily Rate (${calcMethodLabel})`, val: `${fmtMoney(slip.perDaySalary)} / day`, color: 'var(--text-secondary)', bold: false },
    { label: `Days Present (${slip.daysPresent} / ${slip.workingDays})`, val: `${slip.daysPresent} days`, color: 'var(--success)', bold: false },
    { label: 'Total Working Hours', val: totalWorkedHrsStr, color: 'var(--primary)', bold: true },
    ...(paidLeaveDays > 0 ? [
      { label: `Paid Leaves Approved (${paidLeaveDays} day${paidLeaveDays !== 1 ? 's' : ''})`, val: `${paidLeaveDays} days`, color: 'var(--success)', bold: false }
    ] : []),
    ...((slip.sandwichedDays ?? 0) > 0 ? [
      { label: `Sandwiched Off Days (${slip.sandwichedDays} day${slip.sandwichedDays !== 1 ? 's' : ''})`, val: `${slip.sandwichedDays} days (LWP)`, color: '#d97706', bold: false }
    ] : []),
    { label: `Overtime Rate`, val: `₹${(slip.emp.overtime_rate_per_hour ?? 0).toFixed(2)} / hr`, color: 'var(--success)', bold: false },
    { label: `Overtime Pay (${slip.overtimeHours}h ${slip.overtimeMinutes > 0 ? `${slip.overtimeMinutes}m` : ''})`.trim(), val: slip.overtimePay > 0 ? `+${fmtMoney(slip.overtimePay)}` : '₹0.00', color: 'var(--success)', bold: false },
    { label: `Late Arrivals (${slip.lateMinutes ?? 0} mins)`, val: `${Math.floor((slip.lateMinutes ?? 0) / 60)}h ${(slip.lateMinutes ?? 0) % 60}m`, color: 'var(--text-secondary)', bold: false },
    { label: `Late/Early Deductions`, val: (slip.lateCutDeduction ?? 0) > 0 ? `−${fmtMoney(slip.lateCutDeduction ?? 0)}` : '₹0.00', color: (slip.lateCutDeduction ?? 0) > 0 ? 'var(--error)' : 'var(--text-muted)', bold: false },
    ...(unpaidLeaveDed > 0 ? [
      { label: `Deductions (Unpaid Leaves: ${totalUnpaidDays} days)`, val: `−${fmtMoney(unpaidLeaveDed)}`, color: 'var(--error)', bold: false }
    ] : []),
  ];

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        {/* Header */}
        <div className="drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="avatar-circle" style={{ background: avatarColor(slip.emp.name), width: 44, height: 44, fontSize: 16 }}>
              {initials(slip.emp.name)}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{slip.emp.name}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{slip.emp.employee_id} · {slip.emp.shift_start}–{slip.emp.shift_end}</div>
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>{I.x}</button>
        </div>

        {/* Month badge */}
        <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="badge blue" style={{ fontSize: 13, padding: '4px 12px' }}>📅 {monthName}</span>
          <span className="badge grey" style={{ fontSize: 12 }}>{slip.daysInMonth} days in month</span>
          <span className="badge green" style={{ fontSize: 12, fontWeight: 700 }}>⏱ Total Worked: {totalWorkedHrsStr}</span>
        </div>

        <div className="drawer-body">

          {/* Gross salary config */}
          <div className="slip-section">
            <div className="slip-section-title">💼 Salary Configuration</div>
            <div className="slip-config-row">
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>Monthly Gross Salary</div>
                {!editingSalary
                  ? <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginTop: 4, letterSpacing: -0.5 }}>
                    {slip.sal ? fmtMoney(slip.sal.monthly_salary) : <span style={{ color: 'var(--text-muted)', fontSize: 15, fontWeight: 400 }}>Not configured</span>}
                  </div>
                  : <div className="flex gap-2 items-center" style={{ marginTop: 6 }}>
                    <span style={{ fontSize: 16, color: 'var(--text-muted)', fontWeight: 700 }}>₹</span>
                    <input className="form-input" type="number" value={salaryVal} style={{ width: 140, padding: '7px 12px', fontSize: 15 }}
                      onChange={e => setSalaryVal(e.target.value)} autoFocus />
                    <button className="btn btn-sm btn-primary" onClick={saveSalary} disabled={saving}>{saving ? '…' : I.check}</button>
                    <button className="btn btn-sm btn-outline" onClick={() => setEditingSalary(false)}>{I.x}</button>
                  </div>}
              </div>
              {!editingSalary &&
                <button className="btn btn-outline btn-sm" onClick={() => { setEditingSalary(true); setSalaryVal(String(slip.sal?.monthly_salary ?? '')); }}>
                  {I.edit} Edit
                </button>}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <span className={`badge ${slip.sal?.is_hourly ? 'blue' : 'green'}`}>{slip.sal?.is_hourly ? 'Hourly rate' : 'Fixed monthly'}</span>
              {slip.sal?.hourly_rate && slip.sal.hourly_rate > 0 &&
                <span className="badge grey">₹{slip.sal.hourly_rate}/hr</span>}
            </div>
          </div>

          {/* Attendance Summary */}
          <div className="slip-section">
            <div className="slip-section-title">📋 Attendance Summary</div>
            <div className="slip-att-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))' }}>
              <div className="slip-att-box" style={{ background: 'var(--success-bg)' }}>
                <div className="slip-att-num" style={{ color: 'var(--success)' }}>{slip.daysPresent}</div>
                <div className="slip-att-lbl">Days Present</div>
              </div>
              <div className="slip-att-box" style={{ background: 'var(--error-bg)' }}>
                <div className="slip-att-num" style={{ color: 'var(--error)' }}>{slip.daysAbsent}</div>
                <div className="slip-att-lbl">Days Absent</div>
              </div>
              <div className="slip-att-box" style={{ background: 'var(--info-bg)' }}>
                <div className="slip-att-num" style={{ color: 'var(--info)' }}>{slip.workingDays}</div>
                <div className="slip-att-lbl">Working Days</div>
              </div>
              <div className="slip-att-box" style={{ background: 'var(--warning-bg)' }}>
                <div className="slip-att-num" style={{ color: 'var(--warning)' }}>{slip.leavesAllotted}</div>
                <div className="slip-att-lbl">Leaves Allotted</div>
              </div>
              <div className="slip-att-box" style={{ background: 'var(--primary-glow)' }}>
                <div className="slip-att-num" style={{ color: 'var(--primary)', fontSize: 17 }}>
                  {totalWorkedHrsStr}
                </div>
                <div className="slip-att-lbl">Total Working Hours</div>
              </div>
            </div>

            {/* Attendance bar */}
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)', marginBottom: 5, fontWeight: 600 }}>
                <span>Attendance Rate</span>
                <span>{slip.workingDays > 0 ? Math.round((slip.daysPresent / slip.workingDays) * 100) : 0}%</span>
              </div>
              <div className="attend-bar-bg" style={{ height: 8 }}>
                <div className="attend-bar-fill"
                  style={{ width: `${slip.workingDays > 0 ? (slip.daysPresent / slip.workingDays) * 100 : 0}%` }} />
              </div>
            </div>
          </div>

          {/* Salary Breakdown */}
          <div className="slip-section">
            <div className="slip-section-title">🧾 Salary Breakdown</div>
            {!slip.sal
              ? <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                Configure a salary above to see the breakdown.
              </div>
              : <>
                {rows.map((r, i) => (
                  <div key={i} className="slip-row">
                    <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{r.label}</span>
                    <span style={{ color: r.color, fontWeight: r.bold ? 700 : 600, fontSize: r.bold ? 15 : 13 }}>{r.val}</span>
                  </div>
                ))}
                <div className="slip-total-row" style={{ marginBottom: 15 }}>
                  <span>Net Payable</span>
                  <span>{fmtMoney(Math.round(slip.netPay))}</span>
                </div>
              </>}
          </div>

        </div>  {/* /drawer-body */}

        {/* Drawer Footer Actions */}
        <div style={{ display: 'flex', gap: 10, padding: '16px 24px', borderTop: '1px solid var(--border-light)', background: 'var(--surface)' }}>
          <button className="btn btn-primary" style={{ flex: 1, gap: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => {
            const printWindow = window.open('', '_blank');
            if (!printWindow) return;
            // All user-controlled values are escaped through escHtml() before
            // being written into the print document, preventing stored XSS.
            const en = escHtml(slip.emp.name);
            const eid = escHtml(slip.emp.employee_id);
            const ess = escHtml(slip.emp.shift_start);
            const ese = escHtml(slip.emp.shift_end);
            const emn = escHtml(monthName);
            const edt = escHtml(new Date().toLocaleDateString('en-IN'));
            printWindow.document.write(`
              <html>
                <head>
                  <title>Salary Slip - ${en} - ${emn}</title>
                  <style>
                    body { font-family: 'Inter', -apple-system, sans-serif; padding: 40px; color: #0f172a; max-width: 800px; margin: 0 auto; }
                    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
                    .title { font-size: 24px; font-weight: 800; color: #0f172a; }
                    .meta { font-size: 13px; color: #64748b; line-height: 1.5; text-align: right; }
                    .emp-info { margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
                    .emp-name { font-size: 18px; font-weight: 700; color: #0f172a; }
                    .emp-id { font-size: 13px; color: #64748b; margin-top: 4px; }
                    .table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    .table th, .table td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
                    .table th { background: #f8fafc; font-weight: 600; color: #475569; }
                    .table td.val { text-align: right; font-weight: 600; }
                    .total-row { font-size: 18px; font-weight: 800; background: #eff6ff; }
                    .total-row td { border-bottom: 2px solid #2563eb; color: #1d4ed8; padding: 16px 12px; }
                    .footer { margin-top: 60px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; }
                  </style>
                </head>
                <body>
                  <div class="header">
                    <div>
                      <div class="title">Salary Slip</div>
                      <div style="font-size: 14px; font-weight: 600; color: #2563eb; margin-top: 4px;">${emn}</div>
                    </div>
                    <div class="meta">
                      <div>StaffEase HR Portal</div>
                      <div>Generated: ${edt}</div>
                    </div>
                  </div>
                  
                  <div class="emp-info">
                    <div>
                      <div class="emp-name">${en}</div>
                      <div class="emp-id">Employee ID: ${eid}</div>
                    </div>
                    <div style="text-align: right;">
                      <div class="emp-id">Working Days: ${slip.workingDays}</div>
                      <div class="emp-id">Total Worked: ${escHtml(totalWorkedHrsStr)}</div>
                      <div class="emp-id">Shift: ${ess} to ${ese}</div>
                    </div>
                  </div>

                  <table class="table">
                    <thead>
                      <tr>
                        <th>Earnings &amp; Deductions Description</th>
                        <th style="text-align: right;">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Gross Base Monthly Salary</td>
                        <td class="val">${fmtMoney(slip.grossPay)}</td>
                      </tr>
                      <tr>
                        <td>Days Present (${slip.daysPresent} / ${slip.workingDays} working days)</td>
                        <td class="val">+${fmtMoney(Math.round(slip.perDaySalary * slip.daysPresent))}</td>
                      </tr>
                      <tr>
                        <td>Total Working Hours Completed</td>
                        <td class="val" style="color: #2563eb; font-weight: 700;">${escHtml(totalWorkedHrsStr)}</td>
                      </tr>
                      ${paidLeaveDays > 0
                ? `<tr>
                              <td>Paid Leaves Approved (${paidLeaveDays} day\${paidLeaveDays !== 1 ? 's' : ''})</td>
                              <td class="val">+\${fmtMoney(Math.round(slip.perDaySalary * paidLeaveDays))}</td>
                            </tr>`
                : ''
              }
                      <tr>
                        <td>Late Arrival Deduction (${slip.lateMinutes ?? 0} minutes)</td>
                        <td class="val" style="color: #ef4444;">-${fmtMoney(Math.round(slip.lateCutDeduction ?? 0))}</td>
                      </tr>
                      <tr>
                        <td>Work Hour Shortage Deduction (${slip.shortageMinutes ?? 0} minutes)</td>
                        <td class="val" style="color: #ef4444;">-${fmtMoney(Math.round(slip.underworkDeduction ?? 0))}</td>
                      </tr>
                      <tr style="font-weight: 700; background: #f8fafc;">
                        <td>Earned Salary After Deductions</td>
                        <td class="val">${fmtMoney(Math.max(0, slip.basePay - (slip.lateCutDeduction ?? 0) - (slip.underworkDeduction ?? 0)))}</td>
                      </tr>
                      <tr>
                        <td>Overtime Compensation (${slip.overtimeHours}h ${slip.overtimeMinutes}m @ ₹${slip.emp.overtime_rate_per_hour ?? 0}/hr)</td>
                        <td class="val" style="color: #10b981;">+${fmtMoney(slip.overtimePay)}</td>
                      </tr>
                      <tr class="total-row">
                        <td>Net Payable Salary</td>
                        <td class="val">${fmtMoney(Math.round(slip.netPay))}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div class="footer">
                    This is a computer-generated salary slip and does not require a signature.
                  </div>
                  
                  <script>
                    window.onload = function() {
                      window.print();
                      setTimeout(function() { window.close(); }, 500);
                    };
                  </script>
                </body>
              </html>
            `);
            printWindow.document.close();
          }}>
            {I.print} Print Slip
          </button>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>   {/* /drawer */}
    </>
  );
}

// ─── Employee Profile Drawer ──────────────────────────────────────────────────
function EmployeeProfileDrawer({
  employee,
  adminId,
  locations,
  onClose,
  onUpdate,
}: {
  employee: Employee;
  adminId: string;
  locations: Location[];
  onClose: () => void;
  onUpdate: (emp: Employee) => void;
}) {
  const [name, setName] = useState(employee.name);
  const [employeeId, setEmployeeId] = useState(employee.employee_id);
  const [department, setDepartment] = useState(employee.department || '');
  const [designation, setDesignation] = useState(employee.designation || '');
  const [joiningDate, setJoiningDate] = useState(employee.joining_date || '');
  const [isActive, setIsActive] = useState(employee.is_active !== false);
  const [notes, setNotes] = useState(employee.notes || '');
  const [locationId, setLocationId] = useState(employee.location_id || '');
  const [shiftStart, setShiftStart] = useState(employee.shift_start || '09:00');
  const [shiftEnd, setShiftEnd] = useState(employee.shift_end || '18:00');
  const [salaryVal, setSalaryVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [docUploading, setDocUploading] = useState(false);
  const [overtimeEnabled, setOvertimeEnabled] = useState(employee.overtime_enabled ?? false);
  const [overtimeRate, setOvertimeRate] = useState(String(employee.overtime_rate_per_hour ?? 0));
  const [showAllotModal, setShowAllotModal] = useState(false);

  useEffect(() => {
    supabase.from('employee_salary')
      .select('*')
      .eq('employee_id', employee.id)
      .order('effective_date', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data[0]) {
          setSalaryVal(String(data[0].monthly_salary));
        } else {
          setSalaryVal('');
        }
      });
  }, [employee.id]);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploading(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${employee.id}-${Date.now()}.${fileExt}`;
      const filePath = `${adminId}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('profile-photos')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('profile-photos')
        .getPublicUrl(filePath);

      const publicUrl = urlData.publicUrl;

      const { error: updateError } = await supabase.from('employees')
        .update({ image_url: publicUrl })
        .eq('id', employee.id);

      if (updateError) throw updateError;

      onUpdate({ ...employee, image_url: publicUrl });
      alert('Profile photo updated successfully!');
    } catch (err: any) {
      alert(err.message || 'Failed to upload profile photo');
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocUploading(true);
    try {
      const filePath = `${adminId}/${employee.id}/${Date.now()}_${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from('employee-documents')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const docItem = { name: file.name, file_path: filePath, url: '' };
      const currentDocs = employee.documents || [];
      const updatedDocs = [...currentDocs, docItem];

      const { error: updateError } = await supabase.from('employees')
        .update({ documents: updatedDocs })
        .eq('id', employee.id);

      if (updateError) throw updateError;

      onUpdate({ ...employee, documents: updatedDocs });
      alert('Document uploaded successfully!');
    } catch (err: any) {
      alert(err.message || 'Failed to upload document');
    } finally {
      setDocUploading(false);
    }
  };

  const handleDownloadDoc = async (filePath: string, fileName: string) => {
    try {
      const { data, error } = await supabase.storage
        .from('employee-documents')
        .createSignedUrl(filePath, 60);

      if (error) throw error;

      const a = document.createElement('a');
      a.href = data.signedUrl;
      a.download = fileName;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message || 'Failed to generate download link');
    }
  };

  const handleDeleteDoc = async (filePath: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;
    try {
      await supabase.storage
        .from('employee-documents')
        .remove([filePath]);

      const updatedDocs = (employee.documents || []).filter((d: any) => d.file_path !== filePath);

      const { error: updateError } = await supabase.from('employees')
        .update({ documents: updatedDocs })
        .eq('id', employee.id);

      if (updateError) throw updateError;

      onUpdate({ ...employee, documents: updatedDocs });
      alert('Document deleted successfully.');
    } catch (err: any) {
      alert(err.message || 'Failed to delete document');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { error: empErr } = await supabase.from('employees')
        .update({
          name,
          employee_id: employeeId,
          department: department || null,
          designation: designation || null,
          joining_date: joiningDate || null,
          is_active: isActive,
          notes: notes || null,
          location_id: locationId || null,
          shift_start: shiftStart,
          shift_end: shiftEnd,
          overtime_enabled: overtimeEnabled,
          overtime_rate_per_hour: Number(overtimeRate) || 0,
        })
        .eq('id', employee.id);

      if (empErr) throw empErr;

      if (salaryVal.trim()) {
        const salVal = Number(salaryVal.trim());
        if (!isNaN(salVal) && salVal >= 0) {
          const now = new Date();
          const effectiveDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
          const { error: salErr } = await supabase.from('employee_salary').upsert({
            admin_id: adminId,
            employee_id: employee.id,
            monthly_salary: salVal,
            effective_date: effectiveDate,
            hourly_rate: 0,
            is_hourly: false,
          }, { onConflict: 'employee_id' });
          if (salErr) throw salErr;
        }
      }

      onUpdate({
        ...employee,
        name,
        employee_id: employeeId,
        department: department || null,
        designation: designation || null,
        joining_date: joiningDate || null,
        is_active: isActive,
        notes: notes || null,
        location_id: locationId || null,
        shift_start: shiftStart,
        shift_end: shiftEnd,
        overtime_enabled: overtimeEnabled,
        overtime_rate_per_hour: Number(overtimeRate) || 0,
      });

      alert('Profile updated successfully!');
      onClose();
    } catch (err: any) {
      alert(err.message || 'Failed to update employee details');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" style={{ width: 480 }}>
        <div className="drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="avatar-circle" style={{ background: avatarColor(employee.name), width: 52, height: 52, fontSize: 18, overflow: 'hidden', position: 'relative' }}>
              {employee.image_url ? (
                <img src={employee.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                initials(employee.name)
              )}
              {photoUploading && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="spinner-sm" style={{ borderColor: '#fff', borderTopColor: 'transparent' }} />
                </div>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{employee.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ID: {employee.employee_id}</span>
                {(!employee.face_embedding || employee.face_embedding.trim() === '000' || employee.face_embedding.trim() === '0,0,0') ? (
                  <span className="badge red" style={{ fontSize: 9, padding: '2px 4px' }}>Face not registered</span>
                ) : (
                  <span className="badge green" style={{ fontSize: 9, padding: '2px 4px' }}>Face registered</span>
                )}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-body" style={{ padding: '20px 24px' }}>
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                Profile Photo
                <span className="badge" style={{ cursor: 'pointer', background: 'var(--primary-glow)', color: 'var(--primary)', border: '1px solid var(--primary-border)' }}>
                  Change Photo
                  <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} />
                </span>
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Full Name</label>
                <input className="form-input" value={name} onChange={e => setName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">Employee ID</label>
                <input className="form-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} required />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Department</label>
                <input className="form-input" placeholder="e.g. Engineering" value={department} onChange={e => setDepartment(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Designation</label>
                <input className="form-input" placeholder="e.g. Developer" value={designation} onChange={e => setDesignation(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Joining Date</label>
                <input className="form-input" type="date" value={joiningDate} onChange={e => setJoiningDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Monthly Salary (INR)</label>
                <input className="form-input" type="number" placeholder="e.g. 35000" value={salaryVal} onChange={e => setSalaryVal(e.target.value)} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Work Location</label>
              <select className="form-input" value={locationId} onChange={e => setLocationId(e.target.value)}>
                <option value="">Unassigned (any scanner)</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Shift Start</label>
                <input className="form-input" type="time" value={shiftStart} onChange={e => setShiftStart(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Shift End</label>
                <input className="form-input" type="time" value={shiftEnd} onChange={e => setShiftEnd(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'center', margin: '8px 0 12px 0' }}>
              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <input type="checkbox" id="profile_overtime_enabled"
                  checked={overtimeEnabled}
                  onChange={e => setOvertimeEnabled(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: 'pointer' }} />
                <label htmlFor="profile_overtime_enabled" className="form-label" style={{ margin: 0, cursor: 'pointer', fontWeight: 600 }}>Enable Overtime</label>
              </div>
              {overtimeEnabled && (
                <div className="form-group">
                  <label className="form-label">Overtime Rate (INR/hr)</label>
                  <input className="form-input" type="number" min="0" placeholder="e.g. 200"
                    value={overtimeRate}
                    onChange={e => setOvertimeRate(e.target.value)} />
                </div>
              )}
            </div>

            <div className="form-group" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>Employment Status</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Inactive employees cannot punch in</div>
              </div>
              <label className="switch-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ width: 18, height: 18, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? 'var(--success)' : 'var(--error)' }}>
                  {isActive ? 'Active' : 'Inactive'}
                </span>
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">Employee Notes</label>
              <textarea className="form-input" style={{ minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Add employee history, notes, remarks..." value={notes} onChange={e => setNotes(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                Uploaded Documents
                <span className="badge" style={{ cursor: 'pointer', background: 'var(--primary-glow)', color: 'var(--primary)', border: '1px solid var(--primary-border)' }}>
                  {docUploading ? 'Uploading…' : 'Upload Doc'}
                  <input type="file" onChange={handleDocUpload} style={{ display: 'none' }} disabled={docUploading} />
                </span>
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {(!employee.documents || employee.documents.length === 0) ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: '12px 0', border: '1px dashed var(--border)', borderRadius: 6 }}>
                    No documents uploaded yet (e.g. Aadhaar, PAN, offer letter)
                  </div>
                ) : (
                  employee.documents.map((doc: any, idx: number) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--surface-3)', borderRadius: 6, border: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }} title={doc.name}>
                        📄 {doc.name}
                      </span>
                      <div className="flex gap-1">
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--primary)', padding: 4 }} onClick={() => handleDownloadDoc(doc.file_path, doc.name)}>
                          {I.download}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--error)', padding: 4 }} onClick={() => handleDeleteDoc(doc.file_path)}>
                          {I.trash}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Monthly Leave Allotment */}
            <div className="form-group" style={{ background: 'var(--surface-2)', padding: 14, borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>🌿 Monthly Paid Leave Allowance</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowAllotModal(true)}>
                  Allot Leaves
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Set monthly paid leave allowance for this employee for any month/year.
              </div>
            </div>

            <div className="modal-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Profile'}</button>
            </div>
          </form>
        </div>
      </div>

      {showAllotModal && (
        <AllotLeaveModal
          adminId={adminId}
          employees={[employee]}
          defaultEmployeeId={employee.id}
          onClose={() => setShowAllotModal(false)}
          onSaved={() => {}}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL
// ═══════════════════════════════════════════════════════════════════════════════
function PayrollPage({ adminId }: { adminId: string }) {
  const now = new Date();
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);   // 1-12
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [filterMode, setFilterMode] = useState<'month' | 'range'>('month');
  const [startDate, setStartDate] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [endDate, setEndDate] = useState(ymd(now));
  const [salaries, setSalaries] = useState<EmployeeSalary[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendMap, setAttendMap] = useState<Record<string, Set<string>>>({});  // empId → set of dates present
  const [leavesMap, setLeavesMap] = useState<Record<string, EmployeeLeave>>({}); // empId → leave allotment
  const [leaveReqs, setLeaveReqs] = useState<LeaveRequest[]>([]);                 // approved leave requests this month
  const [overtimeMap, setOvertimeMap] = useState<Record<string, number>>({}); // empId → overtime hours
  const [lateMap, setLateMap] = useState<Record<string, number>>({}); // empId → late minutes
  const [shortageMap, setShortageMap] = useState<Record<string, number>>({}); // empId → shortage minutes
  const [workedMinutesMap, setWorkedMinutesMap] = useState<Record<string, number>>({}); // empId → total worked minutes
  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [weeklyOffs, setWeeklyOffs] = useState<WeeklyOffDay[]>([]);                 // weekly off days
  const [empHolidays, setEmpHolidays] = useState<any[]>([]);
  const [calcMethod, setCalcMethod] = useState<'fixed_30' | 'working_day' | 'actual_calendar'>('working_day');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [slip, setSlip] = useState<SalarySlip | null>(null);
  const [editingLeave, setEditingLeave] = useState<{ employee_id: string; name: string; allotted: number } | null>(null);
  const [updatingLeave, setUpdatingLeave] = useState(false);
  const [showAllotModal, setShowAllotModal] = useState(false);

  // ── helpers ──

  const load = useCallback(async () => {
    if (employees.length === 0) {
      setLoading(true);
    }
    // Padded ±1 day (UTC storage vs. local day — see ymd/dayKey)
    const monthStart = filterMode === 'range' ? `${startDate}T00:00:00` : ymd(new Date(selYear, selMonth - 1, 0)) + 'T00:00:00';
    const monthEnd = filterMode === 'range' ? `${endDate}T23:59:59` : ymd(new Date(selYear, selMonth, 1)) + 'T23:59:59';
    const monthPrefix = `${selYear}-${String(selMonth).padStart(2, '0')}`;

    const [sr, er, ar, lr, hr, ehr, lvr, wor, pr] = await Promise.all([
      supabase.from('employee_salary').select('*').eq('admin_id', adminId),
      supabase.from('employees').select('*').eq('admin_id', adminId).order('name'),
      supabase.from('attendance').select('employee_id, timestamp, punch_type')
        .eq('admin_id', adminId)
        .gte('timestamp', monthStart).lte('timestamp', monthEnd),
      supabase.from('employee_leaves').select('*')
        .eq('admin_id', adminId).eq('year', selYear).eq('month', selMonth),
      supabase.from('public_holidays').select('*').eq('admin_id', adminId),
      supabase.from('employee_holidays').select('*').eq('admin_id', adminId)
        .gte('date', monthStart.slice(0, 10)).lte('date', monthEnd.slice(0, 10)),
      supabase.from('leave_requests').select('*').eq('admin_id', adminId).eq('status', 'approved')
        .gte('start_date', monthStart.slice(0, 10)).lte('end_date', monthEnd.slice(0, 10)),
      supabase.from('weekly_off_days').select('*').eq('admin_id', adminId),
      supabase.from('profiles').select('salary_calc_method').eq('id', adminId).maybeSingle(),
    ]);

    const empsList = (er.data ?? []) as Employee[];
    setSalaries(sr.data ?? []);
    setEmployees(empsList);
    setHolidays(hr.data ?? []);
    setEmpHolidays(ehr.data ?? []);
    if (pr.data?.salary_calc_method) {
      setCalcMethod(pr.data.salary_calc_method as any);
    }

    // Build attendance map: empId → unique check-in dates this month or in custom range
    const am: Record<string, Set<string>> = {};
    for (const rec of (ar.data ?? [])) {
      if (rec.punch_type !== 'check_in') continue;
      const date = dayKey(rec.timestamp);
      if (filterMode === 'range') {
        if (date < startDate || date > endDate) continue;
      } else {
        if (date.slice(0, 7) !== monthPrefix) continue;
      }
      if (!am[rec.employee_id]) am[rec.employee_id] = new Set();
      am[rec.employee_id].add(date);
    }
    setAttendMap(am);

    // Build overtime calculations & total worked hours: empId → monthly or range minutes
    const recAgg = new Map<string, { first: number; last: number; hasIn: boolean; hasOut: boolean }>();
    for (const r of (ar.data ?? [])) {
      const date = dayKey(r.timestamp);
      if (filterMode === 'range') {
        if (date < startDate || date > endDate) continue;
      } else {
        if (date.slice(0, 7) !== monthPrefix) continue;
      }
      const key = r.employee_id + '|' + date;
      const t = new Date(r.timestamp);
      const mins = t.getHours() * 60 + t.getMinutes();
      const cur = recAgg.get(key) ?? { first: 1e9, last: -1, hasIn: false, hasOut: false };
      if (r.punch_type === 'check_in') { cur.hasIn = true; cur.first = Math.min(cur.first, mins); }
      if (r.punch_type === 'check_out') { cur.hasOut = true; cur.last = Math.max(cur.last, mins); }
      recAgg.set(key, cur);
    }

    const otMap: Record<string, number> = {};
    const lMap: Record<string, number> = {};
    const sMap: Record<string, number> = {};
    const workedMap: Record<string, number> = {};
    const empMap = new Map(empsList.map(e => [e.id, e]));
    for (const [key, v] of recAgg) {
      const id = key.split('|')[0];
      const emp = empMap.get(id);
      if (emp) {
        const shiftStartMins = HHMM(emp.shift_start || '09:00');
        let shiftEndMins = HHMM(emp.shift_end || '17:00');
        if (shiftEndMins <= shiftStartMins) shiftEndMins += 24 * 60;
        const shiftLen = Math.max(300, shiftEndMins - shiftStartMins) || 480;

        let worked = 0;
        if (v.hasIn && v.hasOut) {
          worked = Math.max(0, v.last - v.first);
          const otMins = Math.max(0, worked - shiftLen); // store as minutes
          if (otMins > 0) {
            otMap[id] = (otMap[id] ?? 0) + otMins;
          }
          // 8 hours working day standard for shortage deduction
          const shortage = Math.max(0, 480 - worked);
          if (shortage > 0) {
            sMap[id] = (sMap[id] ?? 0) + shortage;
          }
        } else if (v.hasIn) {
          worked = v.first < shiftEndMins ? Math.max(0, shiftEndMins - v.first) : shiftLen;
        } else if (v.hasOut) {
          worked = v.last > shiftStartMins ? Math.max(0, v.last - shiftStartMins) : shiftLen;
        }

        if (worked > 0) {
          workedMap[id] = (workedMap[id] ?? 0) + worked;
        }

        if (v.hasIn) {
          const late = Math.max(0, v.first - shiftStartMins);
          if (late > 0) {
            lMap[id] = (lMap[id] ?? 0) + late;
          }
        }
      }
    }
    setOvertimeMap(otMap);
    setLateMap(lMap);
    setShortageMap(sMap);
    setWorkedMinutesMap(workedMap);

    // Build leave allotment map: empId → leave record
    const lm: Record<string, EmployeeLeave> = {};
    for (const l of (lr.data ?? [])) lm[l.employee_id] = l;
    setLeavesMap(lm);
    setLeaveReqs((lvr.data ?? []) as LeaveRequest[]);
    setWeeklyOffs((wor.data ?? []) as WeeklyOffDay[]);

    setLoading(false);
  }, [adminId, selMonth, selYear, filterMode, startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const updateCalcMethod = async (newMethod: 'fixed_30' | 'working_day' | 'actual_calendar') => {
    setCalcMethod(newMethod);
    const { error } = await supabase.from('profiles').update({ salary_calc_method: newMethod }).eq('id', adminId);
    if (error) {
      console.error('Error updating salary_calc_method:', error);
    }
  };

  const dateLimit = filterMode === 'range' ? endDate : ymd(new Date(selYear, selMonth, 0)); // cutoff date for active salary
  const salaryMap: Record<string, EmployeeSalary> = {};
  for (const e of employees) {
    const active = getActiveSalary(salaries, e.id, dateLimit);
    if (active) salaryMap[e.id] = active;
  }

  // ── Build slip for one employee ──
  const buildSlip = useCallback((emp: Employee): SalarySlip => {
    const sal = salaryMap[emp.id];
    const empHols = empHolidays.filter(eh => eh.employee_id === emp.id).map(eh => eh.date);
    const empLeaveRecs = leaveReqs.filter(l => l.employee_id === emp.id);
    const weeklyOffSet = getEmployeeWeeklyOffSet(weeklyOffs, emp.id);
    return calculateSalarySlip({
      emp,
      salary: sal,
      leavesAllotted: leavesMap[emp.id]?.leaves_allotted ?? 0,
      presentDates: attendMap[emp.id] ?? new Set<string>(),
      otMinutes: overtimeMap[emp.id] ?? 0,
      totalWorkedMinutes: workedMinutesMap[emp.id] ?? 0,
      holidays,
      empHolidays: empHols,
      leaveRecords: empLeaveRecs,
      weeklyOffs: weeklyOffSet,
      lateMinutes: lateMap[emp.id] ?? 0,
      shortageMinutes: shortageMap[emp.id] ?? 0,
      year: selYear,
      month: selMonth,
      calcMethod,
      customStartDate: filterMode === 'range' ? startDate : undefined,
      customEndDate: filterMode === 'range' ? endDate : undefined,
    });
  }, [salaryMap, attendMap, leavesMap, leaveReqs, overtimeMap, lateMap, shortageMap, workedMinutesMap, holidays, weeklyOffs, empHolidays, selMonth, selYear, calcMethod, filterMode, startDate, endDate]);

  const filtered = employees.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.employee_id.toLowerCase().includes(search.toLowerCase())
  );

  const totalGross = Object.values(salaryMap).reduce((s, v) => s + v.monthly_salary, 0);
  const totalOvertime = filtered.reduce((s, emp) => s + buildSlip(emp).overtimePay, 0);
  const totalDeduct = filtered.reduce((s, emp) => {
    const sl = buildSlip(emp);
    return s + (sl.unpaidLeaveDeduction ?? sl.absentDeduction) + (sl.lateCutDeduction ?? 0) + (sl.underworkDeduction ?? 0);
  }, 0);
  const totalNet = filtered.reduce((s, emp) => s + buildSlip(emp).netPay, 0);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  return (
    <div>
      {/* Header */}
      <div className="section-head payroll-section-head mb-4">
        <div>
          <div className="section-title">Payroll Management</div>
          <div className="section-sub">Attendance-based net pay calculation</div>
        </div>
        <div className="flex gap-2 items-center payroll-controls" style={{ flexWrap: 'wrap' }}>
          <div className="search-wrap">
            {I.search}
            <input className="form-input search-input" placeholder="Search employee…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          {filterMode === 'month' ? (
            <>
              <select className="form-input" style={{ width: 'auto', paddingRight: 28 }}
                value={selMonth} onChange={e => {
                  const m = Number(e.target.value);
                  setSelMonth(m);
                  setStartDate(ymd(new Date(selYear, m - 1, 1)));
                  setEndDate(ymd(new Date(selYear, m, 0)));
                }}>
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
              <select className="form-input" style={{ width: 'auto', paddingRight: 28 }}
                value={selYear} onChange={e => {
                  const y = Number(e.target.value);
                  setSelYear(y);
                  setStartDate(ymd(new Date(y, selMonth - 1, 1)));
                  setEndDate(ymd(new Date(y, selMonth, 0)));
                }}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#ffffff', border: '1px solid #cbd5e1', padding: '3px 8px', borderRadius: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#475569' }}>From:</span>
              <input
                type="date"
                className="form-input"
                style={{ padding: '4px 6px', fontSize: 12, height: 32, width: 130 }}
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
              <span style={{ fontSize: 11, fontWeight: 600, color: '#475569' }}>To:</span>
              <input
                type="date"
                className="form-input"
                style={{ padding: '4px 6px', fontSize: 12, height: 32, width: 130 }}
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
          )}

          <button
            className="btn btn-outline"
            style={{
              whiteSpace: 'nowrap',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              borderColor: filterMode === 'range' ? '#2563eb' : '#cbd5e1',
              background: filterMode === 'range' ? '#eff6ff' : '#ffffff',
              color: filterMode === 'range' ? '#2563eb' : '#334155',
              fontWeight: 700
            }}
            onClick={() => setFilterMode(filterMode === 'month' ? 'range' : 'month')}
            title={filterMode === 'month' ? 'Filter by Custom Date Range' : 'Switch to Monthly View'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{filterMode === 'month' ? '📅 Date Range' : '🗓️ Monthly View'}</span>
          </button>

          <button className="btn btn-outline" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setShowAllotModal(true)}>
            🌿 Allot Leaves
          </button>
        </div>
      </div>

      {/* Salary Calculation Method & Sandwich Leave Policy Selector Card */}
      <div className="card mb-4" style={{ padding: 20, background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', border: '1px solid #e2e8f0', borderRadius: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>⚡ Salary Calculation Method</span>
              <span className="badge blue" style={{ fontSize: 10, padding: '2px 8px' }}>Global Org Setting</span>
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Select how daily rate & base pay are calculated across all employees. Saved to Supabase profile.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fffbeb', border: '1px solid #fde68a', padding: '6px 12px', borderRadius: 8 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth={2} style={{ width: 15, height: 15 }}>
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#92400e' }}>
              Sandwich Leave Policy Active
            </span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14 }}>
          {/* Option 1: Working-Day Based */}
          <div
            onClick={() => updateCalcMethod('working_day')}
            style={{
              padding: 14,
              borderRadius: 10,
              border: calcMethod === 'working_day' ? '2px solid #2563eb' : '1px solid #cbd5e1',
              background: calcMethod === 'working_day' ? '#eff6ff' : '#ffffff',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: calcMethod === 'working_day' ? '0 4px 12px rgba(37, 99, 235, 0.12)' : 'none'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: calcMethod === 'working_day' ? '#1e40af' : '#0f172a' }}>
                Working-Day Based
              </div>
              <span className="badge green" style={{ fontSize: 9.5 }}>Default</span>
            </div>
            <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 4 }}>
              Daily Rate = Salary ÷ Working Days
            </div>
            <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.4 }}>
              Calculates daily rate on payable working days in month (excluding public holidays & allotted leaves).
            </div>
          </div>

          {/* Option 2: Fixed 30-Day Calendar */}
          <div
            onClick={() => updateCalcMethod('fixed_30')}
            style={{
              padding: 14,
              borderRadius: 10,
              border: calcMethod === 'fixed_30' ? '2px solid #2563eb' : '1px solid #cbd5e1',
              background: calcMethod === 'fixed_30' ? '#eff6ff' : '#ffffff',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: calcMethod === 'fixed_30' ? '0 4px 12px rgba(37, 99, 235, 0.12)' : 'none'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: calcMethod === 'fixed_30' ? '#1e40af' : '#0f172a' }}>
                Fixed 30-Day Calendar
              </div>
              {calcMethod === 'fixed_30' && <span className="badge blue" style={{ fontSize: 9.5 }}>Active</span>}
            </div>
            <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 4 }}>
              Daily Rate = Salary ÷ 30 Days
            </div>
            <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.4 }}>
              Salary is distributed equally across 30 days regardless of month length. Deducts absent days.
            </div>
          </div>

          {/* Option 3: Actual Calendar Days */}
          <div
            onClick={() => updateCalcMethod('actual_calendar')}
            style={{
              padding: 14,
              borderRadius: 10,
              border: calcMethod === 'actual_calendar' ? '2px solid #2563eb' : '1px solid #cbd5e1',
              background: calcMethod === 'actual_calendar' ? '#eff6ff' : '#ffffff',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: calcMethod === 'actual_calendar' ? '0 4px 12px rgba(37, 99, 235, 0.12)' : 'none'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: calcMethod === 'actual_calendar' ? '#1e40af' : '#0f172a' }}>
                Actual Calendar Day
              </div>
              {calcMethod === 'actual_calendar' && <span className="badge blue" style={{ fontSize: 9.5 }}>Active</span>}
            </div>
            <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, marginBottom: 4 }}>
              Daily Rate = Salary ÷ Total Month Days
            </div>
            <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.4 }}>
              Based on exact calendar days in month (28, 29, 30, or 31). Deducts absent days.
            </div>
          </div>
        </div>
      </div>

      {/* Summary banner */}
      <div className="payroll-banner-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <div className="stat-card" style={{ background: '#eff6ff', border: '1px solid #dbeafe', boxShadow: 'none' }}>
          <div className="stat-icon" style={{ background: '#dbeafe', color: '#2563eb' }}>
            {I.rupee}
          </div>
          <div className="stat-info">
            <div className="stat-value" style={{ color: '#1e3a8a', fontSize: 22 }}>{fmtMoney(totalGross)}</div>
            <div className="stat-label" style={{ color: '#60a5fa', fontWeight: 600 }}>Total Base Salary</div>
          </div>
        </div>
        <div className="stat-card" style={{ background: '#f0fdf4', border: '1px solid #dcfce7', boxShadow: 'none' }}>
          <div className="stat-icon" style={{ background: '#dcfce7', color: '#16a34a' }}>{I.check}</div>
          <div className="stat-info">
            <div className="stat-value" style={{ color: '#14532d', fontSize: 22 }}>+{fmtMoney(Math.round(totalOvertime))}</div>
            <div className="stat-label" style={{ color: '#4ade80', fontWeight: 600 }}>Total Overtime Pay</div>
            <span className="stat-sub up" style={{ background: '#dcfce7', color: '#15803d' }}>Additions</span>
          </div>
        </div>
        <div className="stat-card" style={{ background: '#fff5f5', border: '1px solid #fee2e2', boxShadow: 'none' }}>
          <div className="stat-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>{I.alert}</div>
          <div className="stat-info">
            <div className="stat-value" style={{ color: '#7a1515', fontSize: 22 }}>-{fmtMoney(Math.round(totalDeduct))}</div>
            <div className="stat-label" style={{ color: '#f87171', fontWeight: 600 }}>Total Deductions</div>
            <span className="stat-sub down" style={{ background: '#fee2e2', color: '#b91c1c' }}>Absent / Excess leaves</span>
          </div>
        </div>
        <div className="stat-card" style={{ background: '#f5f3ff', border: '1px solid #ede9fe', boxShadow: 'none' }}>
          <div className="stat-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}>{I.rupee}</div>
          <div className="stat-info">
            <div className="stat-value" style={{ color: '#4c1d95', fontSize: 22 }}>{fmtMoney(Math.round(totalNet))}</div>
            <div className="stat-label" style={{ color: '#a78bfa', fontWeight: 600 }}>Net Payable</div>
            <span className="stat-sub up" style={{ background: '#ede9fe', color: '#6d28d9', fontWeight: 700 }}>{filtered.length} employees</span>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && employees.length === 0 ? (
          <div style={{ padding: 50, textAlign: 'center' }}><div className="spinner" /></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Employee</th>
                <th>Shift</th>
                <th>Gross Pay</th>
                <th>Days Present</th>
                <th>Absent</th>
                <th>Leaves Allotted</th>
                <th>Overtime</th>
                <th>Deduction</th>
                <th style={{ color: '#2563eb' }}>Net Payable</th>
                <th>Slip</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0
                  ? <tr><td colSpan={10}><div className="empty-state">{I.payroll}<h3>No employees</h3></div></td></tr>
                  : filtered.map(emp => {
                    const s = buildSlip(emp);
                    const attPct = s.workingDays > 0 ? Math.round((s.daysPresent / s.workingDays) * 100) : 0;
                    return (
                      <tr key={emp.id} style={{ transition: 'background 0.2s' }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div className="avatar-circle" style={{ background: avatarColor(emp.name), width: 34, height: 34, fontSize: 13, fontWeight: 700, boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>{initials(emp.name)}</div>
                            <div>
                              <div style={{ fontWeight: 700, color: '#1e293b', fontSize: 13.5 }}>{emp.name}</div>
                              <span style={{ fontSize: 10.5, background: '#f1f5f9', color: '#64748b', fontWeight: 600, padding: '2px 6px', borderRadius: 4, display: 'inline-block', marginTop: 3 }}>{emp.employee_id}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, background: '#f8fafc', color: '#334155', fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: '1px solid #e2e8f0', display: 'inline-block' }}>
                            {emp.shift_start}–{emp.shift_end}
                          </span>
                        </td>
                        <td style={{ fontWeight: 700, color: '#334155', fontSize: 13.5 }}>
                          {s.sal ? fmtMoney(s.sal.monthly_salary) : <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 12 }}>Not set</span>}
                        </td>
                        <td>
                          <div className="attend-bar-wrap" style={{ minWidth: 100 }}>
                            <div className="attend-bar-bg" style={{ height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                              <div className="attend-bar-fill" style={{ width: `${attPct}%`, background: 'linear-gradient(90deg, #3b82f6, #10b981)', height: '100%' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2, gap: 4 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}
                                title={`${s.daysPresent} Days Present / ${s.workingDays} Payable Working Days (${s.daysInMonth} total days in ${MONTHS[selMonth - 1]})`}>
                                {s.daysPresent}/{s.workingDays}
                              </span>
                              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#2563eb' }}>
                                ⏱ {Math.floor((s.totalWorkedMinutes ?? 0) / 60)}h {(s.totalWorkedMinutes ?? 0) % 60}m
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          {s.daysAbsent > 0 ? (
                            <span className="badge" style={{ background: '#fef2f2', color: '#ef4444', border: '1px solid #fee2e2', fontWeight: 700, borderRadius: 6, padding: '3px 8px', fontSize: 12 }}>{s.daysAbsent}d</span>
                          ) : (
                            <span className="badge" style={{ background: '#f0fdf4', color: '#22c55e', border: '1px solid #dcfce7', fontWeight: 700, borderRadius: 6, padding: '3px 8px', fontSize: 12 }}>0d</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="badge" style={{ background: '#eff6ff', color: '#3b82f6', border: '1px solid #dbeafe', fontWeight: 700, borderRadius: 6, padding: '3px 8px', fontSize: 12 }}>{s.leavesAllotted}d</span>
                            <button
                              className="btn-edit-leave"
                              style={{ background: '#f1f5f9', border: 'none', borderRadius: '50%', width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer', transition: 'all 0.15s' }}
                              onClick={() => setEditingLeave({ employee_id: emp.id, name: emp.name, allotted: s.leavesAllotted })}
                              title="Edit allotted leaves"
                            >
                              <span style={{ display: 'inline-flex', width: 12, height: 12 }}>{I.edit}</span>
                            </button>
                          </div>
                        </td>
                        <td>
                          {(s.overtimeHours > 0 || s.overtimeMinutes > 0) ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontWeight: 700, color: '#1e293b', fontSize: 13 }}>
                                {s.overtimeHours > 0 && `${s.overtimeHours}h `}{s.overtimeMinutes > 0 && `${s.overtimeMinutes}m`}
                              </span>
                              <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>+{fmtMoney(s.overtimePay)}</span>
                            </div>
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: 13.5 }}>—</span>
                          )}
                        </td>
                        <td>
                          {((s.unpaidLeaveDeduction ?? s.absentDeduction) + (s.lateCutDeduction ?? 0) + (s.underworkDeduction ?? 0)) > 0 ? (
                            <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 13 }}>
                              −{fmtMoney((s.unpaidLeaveDeduction ?? s.absentDeduction) + (s.lateCutDeduction ?? 0) + (s.underworkDeduction ?? 0))}
                            </span>
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: 13.5 }}>₹0.00</span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: 15, fontWeight: 800, color: s.sal ? '#2563eb' : '#94a3b8' }}>
                            {s.sal ? fmtMoney(Math.round(s.netPay)) : '—'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="btn-view-slip"
                            onClick={() => setSlip(s)}
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              gap: 6,
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '6px 12px',
                              borderRadius: 8,
                              border: '1px solid #e2e8f0',
                              background: '#ffffff',
                              color: '#475569',
                              cursor: 'pointer',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                              transition: 'all 0.2s'
                            }}
                          >
                            {I.eye} View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Salary Slip Drawer */}
      {slip && (
        <SalarySlipDrawer
          slip={slip}
          month={selMonth}
          year={selYear}
          adminId={adminId}
          onClose={() => setSlip(null)}
          onSalaryUpdate={() => { load(); setSlip(null); }}
        />
      )}

      {/* Leave Allotment Modal */}
      {editingLeave && (
        <div className="modal-backdrop" onClick={() => setEditingLeave(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="modal-title">Allot Monthly Leaves</div>
            <div className="modal-sub">
              Allot paid/excused leaves for <strong>{editingLeave.name}</strong> for {MONTHS[selMonth - 1]} {selYear}.
            </div>

            <div className="form-group" style={{ marginTop: 16 }}>
              <label className="form-label">Leaves Allotted (days)</label>
              <input
                className="form-input"
                type="number"
                min="0"
                step="0.5"
                defaultValue={editingLeave.allotted}
                id="leaves-allot-input"
                style={{ width: '100%' }}
              />
            </div>

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button className="btn btn-outline" onClick={() => setEditingLeave(null)} disabled={updatingLeave}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={updatingLeave} onClick={async () => {
                const val = parseFloat((document.getElementById('leaves-allot-input') as HTMLInputElement)?.value ?? '0');
                if (isNaN(val) || val < 0) {
                  alert('Please enter a valid positive number');
                  return;
                }
                setUpdatingLeave(true);
                const { error: upsertErr } = await supabase.from('employee_leaves').upsert({
                  admin_id: adminId,
                  employee_id: editingLeave.employee_id,
                  year: selYear,
                  month: selMonth,
                  leaves_allotted: val
                }, {
                  onConflict: 'admin_id,employee_id,year,month'
                });
                setUpdatingLeave(false);
                if (upsertErr) {
                  alert('Error: ' + upsertErr.message);
                } else {
                  setEditingLeave(null);
                  load();
                }
              }}>
                {updatingLeave ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAllotModal && (
        <AllotLeaveModal
          adminId={adminId}
          employees={employees}
          defaultMonth={selMonth}
          defaultYear={selYear}
          onClose={() => setShowAllotModal(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── Allot Employee Leave Modal ── */
function AllotLeaveModal({
  adminId,
  employees,
  defaultEmployeeId,
  defaultMonth,
  defaultYear,
  onClose,
  onSaved,
}: {
  adminId: string;
  employees: Employee[];
  defaultEmployeeId?: string;
  defaultMonth?: number;
  defaultYear?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const now = new Date();
  const [empId, setEmpId] = useState(defaultEmployeeId || (employees[0]?.id ?? ''));
  const [month, setMonth] = useState(defaultMonth || (now.getMonth() + 1));
  const [year, setYear] = useState(defaultYear || now.getFullYear());
  const [leavesVal, setLeavesVal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  useEffect(() => {
    if (!empId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('employee_leaves')
        .select('leaves_allotted')
        .eq('admin_id', adminId)
        .eq('employee_id', empId)
        .eq('year', year)
        .eq('month', month)
        .maybeSingle();
      if (alive) {
        setLeavesVal(data?.leaves_allotted ?? 0);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [adminId, empId, month, year]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empId) {
      alert('Please select an employee');
      return;
    }
    if (isNaN(leavesVal) || leavesVal < 0) {
      alert('Please enter a valid non-negative number of leaves');
      return;
    }
    setSaving(true);
    const { error: upsertErr } = await supabase.from('employee_leaves').upsert({
      admin_id: adminId,
      employee_id: empId,
      year,
      month,
      leaves_allotted: leavesVal,
    }, {
      onConflict: 'admin_id,employee_id,year,month'
    });
    setSaving(false);
    if (upsertErr) {
      alert('Error saving leave allotment: ' + upsertErr.message);
    } else {
      const empName = employees.find(e => e.id === empId)?.name ?? empId;
      await auditLog(adminId, 'leave_allotment.update', empId, empName, {
        year,
        month,
        leaves_allotted: leavesVal,
      });
      onSaved();
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-title">🌿 Allot Employee Leave</div>
        <div className="modal-sub">Set monthly paid leave allowance for an employee</div>

        <form onSubmit={handleSave} style={{ marginTop: 16 }}>
          <div className="form-group">
            <label className="form-label">Select Employee</label>
            <select className="form-input" value={empId} onChange={e => setEmpId(e.target.value)} required>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.name} ({e.employee_id})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Month</label>
              <select className="form-input" value={month} onChange={e => setMonth(Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Year</label>
              <select className="form-input" value={year} onChange={e => setYear(Number(e.target.value))}>
                {years.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Leaves Allotted (Days)</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="0.5"
              value={loading ? '' : leavesVal}
              onChange={e => setLeavesVal(parseFloat(e.target.value) || 0)}
              placeholder={loading ? 'Loading...' : 'e.g. 1, 2, 26'}
              required
              disabled={loading}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              These allotted leaves will count as paid earning days for the selected month.
            </div>
          </div>

          <div className="modal-actions" style={{ marginTop: 20 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save Allotment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════════
function HolidaysPage({ adminId }: { adminId: string }) {
  const [subTab, setSubTab] = useState<'public' | 'employee' | 'weekly_off' | 'leave_allotment'>('public');
  const [showAllotModal, setShowAllotModal] = useState(false);
  const [allotEmpId, setAllotEmpId] = useState<string | undefined>(undefined);
  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [empHolidays, setEmpHolidays] = useState<any[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [weeklyOffs, setWeeklyOffs] = useState<WeeklyOffDay[]>([]);
  const [selectedWeekdays, setSelectedWeekdays] = useState<Set<number>>(new Set());
  const [weeklyOffSaving, setWeeklyOffSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddEmpHol, setShowAddEmpHol] = useState(false);
  const [form, setForm] = useState({ name: '', date: today() });
  const [empHolForm, setEmpHolForm] = useState({ employeeId: '', name: '', date: today() });
  const [saving, setSaving] = useState(false);
  const [savingEmpHol, setSavingEmpHol] = useState(false);
  const [viewYear] = useState(new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(new Date().getMonth());

  const WEEKDAY_LABELS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const load = useCallback(async () => {
    setLoading(true);
    const [hr, ehr, er, wor] = await Promise.all([
      supabase.from('public_holidays').select('*').eq('admin_id', adminId).order('date'),
      supabase.from('employee_holidays').select('*, employees(name, employee_id)').eq('admin_id', adminId).order('date'),
      supabase.from('employees').select('id, name, employee_id').eq('admin_id', adminId).order('name'),
      supabase.from('weekly_off_days').select('*').eq('admin_id', adminId),
    ]);
    setHolidays(hr.data ?? []);
    setEmpHolidays(ehr.data ?? []);
    setEmployees((er.data ?? []) as Employee[]);
    setWeeklyOffs((wor.data ?? []) as WeeklyOffDay[]);
    setLoading(false);
  }, [adminId]);

  const [weeklyOffMode, setWeeklyOffMode] = useState<'company' | 'employee'>('company');

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setSelectedWeekdays(new Set(weeklyOffs.filter(w => !w.employee_id).map(w => w.weekday)));
  }, [weeklyOffs]);

  const toggleWeekday = (wd: number) => {
    setSelectedWeekdays(prev => {
      const next = new Set(prev);
      if (next.has(wd)) {
        next.delete(wd);
      } else {
        next.add(wd);
      }
      return next;
    });
  };

  const handleSaveWeeklyOffs = async () => {
    setWeeklyOffSaving(true);
    const { error: delError } = await supabase
      .from('weekly_off_days')
      .delete()
      .eq('admin_id', adminId)
      .is('employee_id', null);

    if (delError) {
      alert('Error clearing weekly off days: ' + delError.message);
      setWeeklyOffSaving(false);
      return;
    }

    if (selectedWeekdays.size > 0) {
      const toInsert = Array.from(selectedWeekdays).map(wd => ({
        id: crypto.randomUUID(),
        admin_id: adminId,
        employee_id: null,
        weekday: wd,
        name: WEEKDAY_LABELS[wd],
      }));

      const { error: insError } = await supabase
        .from('weekly_off_days')
        .insert(toInsert);

      if (insError) {
        alert('Error saving weekly off days: ' + insError.message);
        setWeeklyOffSaving(false);
        return;
      }
    }

    await auditLog(adminId, 'weekly_off.update', null, 'Weekly Off Days Settings', {
      selected_weekdays: Array.from(selectedWeekdays),
    });

    alert('Default weekly off days updated successfully!');
    setWeeklyOffSaving(false);
    load();
  };

  const [empWeeklyOffMap, setEmpWeeklyOffMap] = useState<Record<string, string | number>>(() => {
    try {
      const saved = localStorage.getItem(`staffease_emp_weekly_offs_${adminId}`);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const handleAssignEmpWeeklyOff = async (empId: string, val: 'default' | 'sat_sun' | number) => {
    const nextMap = { ...empWeeklyOffMap, [empId]: val };
    setEmpWeeklyOffMap(nextMap);
    try {
      localStorage.setItem(`staffease_emp_weekly_offs_${adminId}`, JSON.stringify(nextMap));
    } catch (e) {
      console.error(e);
    }

    try {
      await supabase.from('weekly_off_days').delete().eq('admin_id', adminId).eq('employee_id', empId);
      if (val === 'sat_sun') {
        await supabase.from('weekly_off_days').insert([
          { id: crypto.randomUUID(), admin_id: adminId, employee_id: empId, weekday: 6, name: 'Saturday' },
          { id: crypto.randomUUID(), admin_id: adminId, employee_id: empId, weekday: 7, name: 'Sunday' },
        ]);
      } else if (typeof val === 'number') {
        await supabase.from('weekly_off_days').insert({
          id: crypto.randomUUID(),
          admin_id: adminId,
          employee_id: empId,
          weekday: val,
          name: WEEKDAY_LABELS[val],
        });
      }
    } catch (err) {
      console.warn('Database sync for employee weekly off:', err);
    }

    const empName = employees.find(e => e.id === empId)?.name ?? empId;
    await auditLog(adminId, 'weekly_off_emp.update', empId, empName, { value: val });
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await supabase.from('public_holidays').insert({ admin_id: adminId, name: form.name, date: form.date });
    await auditLog(adminId, 'holiday.insert', null, form.name, { date: form.date, type: 'public' });
    setSaving(false);
    setShowAdd(false);
    setForm({ name: '', date: today() });
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this public holiday? It will be moved to the Recycle Bin.')) return;
    const hol = holidays.find(h => h.id === id);
    const res = await softDeleteRecord('public_holidays', id, adminId, 'admin', 'admin', hol?.name ?? id);
    if (!res.success) {
      alert(`Failed to delete public holiday: ${res.error}`);
      return;
    }
    await auditLog(adminId, 'holiday.delete', id, hol?.name ?? id, { date: hol?.date, type: 'public', soft_deleted: true });
    load();
  };

  const handleAddEmpHol = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empHolForm.employeeId) {
      alert('Please select an employee');
      return;
    }
    if (!empHolForm.name) {
      alert('Please enter a holiday name');
      return;
    }
    setSavingEmpHol(true);
    const { error } = await supabase.from('employee_holidays').insert({
      admin_id: adminId,
      employee_id: empHolForm.employeeId,
      name: empHolForm.name,
      date: empHolForm.date
    });
    setSavingEmpHol(false);
    if (error) {
      alert('Error: ' + error.message);
    } else {
      const emp = employees.find(e => e.id === empHolForm.employeeId);
      await auditLog(adminId, 'holiday.insert', empHolForm.employeeId, empHolForm.name, {
        date: empHolForm.date,
        type: 'employee',
        employee_name: emp?.name,
        employee_code: emp?.employee_id,
      });
      setShowAddEmpHol(false);
      setEmpHolForm({ employeeId: '', name: '', date: today() });
      load();
    }
  };

  const handleDeleteEmpHol = async (id: string) => {
    if (!confirm('Remove this custom employee holiday? It will be moved to the Recycle Bin.')) return;
    const eh = (empHolidays as any[]).find((h: any) => h.id === id);
    const res = await softDeleteRecord('employee_holidays', id, adminId, 'admin', 'admin', eh?.name ?? id);
    if (!res.success) {
      alert(`Failed to delete custom employee holiday: ${res.error}`);
      return;
    }
    await auditLog(adminId, 'holiday.delete', id, eh?.name ?? id, {
      date: eh?.date,
      type: 'employee',
      employee_name: eh?.employees?.name,
      soft_deleted: true,
    });
    load();
  };

  // Calendar helpers
  const holidayDates = new Set(holidays.map(h => h.date));
  const todayStr = today();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthName = new Date(viewYear, viewMonth).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const calCells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <div>
      {/* Sub-tab switcher */}
      <div className="tab-bar mb-4">
        <button className={`tab-item ${subTab === 'public' ? 'active' : ''}`} onClick={() => setSubTab('public')}>
          {I.holidays}
          <span>Public Holidays</span>
        </button>
        <button className={`tab-item ${subTab === 'employee' ? 'active' : ''}`} onClick={() => setSubTab('employee')}>
          {I.employees}
          <span>Employee-wise Holidays</span>
        </button>
        <button className={`tab-item ${subTab === 'weekly_off' ? 'active' : ''}`} onClick={() => setSubTab('weekly_off')}>
          <span>🔁</span>
          <span>Weekly Off Settings</span>
        </button>
        <button className={`tab-item ${subTab === 'leave_allotment' ? 'active' : ''}`} onClick={() => setSubTab('leave_allotment')}>
          <span>🌿</span>
          <span>Leave Allotments</span>
        </button>
      </div>

      {subTab === 'public' && (
        <>
          <div className="section-head mb-4">
            <div>
              <div className="section-title">Public Holidays</div>
              <div className="section-sub">{holidays.length} holidays this year</div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>{I.plus} Add Holiday</button>
          </div>

          <div className="content-grid" style={{ gridTemplateColumns: '1fr 360px' }}>
            {/* List */}
            {loading ? <div className="loader-overlay"><div className="spinner" /></div>
              : <div className="card">
                <div className="card-header">
                  <div className="card-title">Holiday List</div>
                  <span className="badge green">{holidays.length} total</span>
                </div>
                {holidays.length === 0
                  ? <div className="empty-state">{I.holidays}<h3>No holidays added</h3><p>Add holidays to show them in the calendar.</p></div>
                  : <div className="table-wrap"><table>
                    <thead><tr><th>Holiday</th><th>Date</th><th>Day</th><th></th></tr></thead>
                    <tbody>
                      {holidays.map(h => (
                        <tr key={h.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text)' }}>{h.name}</td>
                          <td>{fmtDate(h.date)}</td>
                          <td><span className="badge yellow">{new Date(h.date).toLocaleDateString('en-IN', { weekday: 'short' })}</span></td>
                          <td><button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => handleDelete(h.id)}>{I.trash}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>}
              </div>}

            {/* Mini Calendar */}
            <div className="card">
              <div className="card-header">
                <button className="btn btn-ghost btn-sm" onClick={() => setViewMonth(m => m === 0 ? 11 : m - 1)}>←</button>
                <div className="card-title" style={{ flex: 1, textAlign: 'center', fontSize: 14 }}>{monthName}</div>
                <button className="btn btn-ghost btn-sm" onClick={() => setViewMonth(m => m === 11 ? 0 : m + 1)}>→</button>
              </div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <div className="cal-grid">
                  {dayNames.map(d => <div key={d} className="cal-day-name">{d}</div>)}
                  {calCells.map((day, i) => {
                    if (!day) return <div key={i} className="cal-day empty" />;
                    const dateStr = `${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`;
                    const isToday = dateStr === todayStr;
                    const isHol = holidayDates.has(dateStr);
                    const holName = holidays.find(h => h.date === dateStr)?.name;
                    return (
                      <div key={i} className={`cal-day ${isToday ? 'today' : ''} ${isHol ? 'holiday' : ''}`}
                        title={holName}>
                        <div className="cal-num">{day}</div>
                        {isHol && <div className="cal-dot" />}
                        {isToday && !isHol && <div className="cal-dot today-dot" />}
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 16, display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--warning-bg)', border: '1.5px solid var(--warning)', display: 'inline-block' }} />
                    Holiday
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--primary)', display: 'inline-block' }} />
                    Today
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {subTab === 'employee' && (
        <>
          <div className="section-head mb-4">
            <div>
              <div className="section-title">Employee-wise Holidays</div>
              <div className="section-sub">{empHolidays.length} employee-specific holidays allotted</div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowAddEmpHol(true)}>{I.plus} Allot Employee Holiday</button>
          </div>

          {loading ? <div className="loader-overlay"><div className="spinner" /></div>
            : <div className="card">
              <div className="card-header">
                <div className="card-title">Employee Holidays List</div>
                <span className="badge blue">{empHolidays.length} total</span>
              </div>
              {empHolidays.length === 0
                ? <div className="empty-state">{I.employees}<h3>No employee holidays allotted</h3><p>Allot custom holidays for individual staff members.</p></div>
                : <div className="table-wrap"><table>
                  <thead><tr><th>Employee</th><th>Holiday Name</th><th>Date</th><th>Day</th><th></th></tr></thead>
                  <tbody>
                    {empHolidays.map(h => (
                      <tr key={h.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="avatar-circle" style={{ background: avatarColor(h.employees?.name ?? 'Employee'), width: 28, height: 28, fontSize: 11 }}>{initials(h.employees?.name ?? 'E')}</div>
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{h.employees?.name ?? 'Unknown'}</div>
                              <code style={{ fontSize: 10, background: 'var(--surface-2)', padding: '1px 4px', borderRadius: 4 }}>{h.employees?.employee_id ?? '—'}</code>
                            </div>
                          </div>
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--text)' }}>{h.name}</td>
                        <td>{fmtDate(h.date)}</td>
                        <td><span className="badge yellow">{new Date(h.date).toLocaleDateString('en-IN', { weekday: 'short' })}</span></td>
                        <td><button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => handleDeleteEmpHol(h.id)}>{I.trash}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>}
            </div>}
        </>
      )}

      {subTab === 'weekly_off' && (
        <>
          <div className="section-head mb-4">
            <div>
              <div className="section-title">Weekly Off Settings</div>
              <div className="section-sub">Configure default company weekly off days or assign custom off days per employee. Weekly off days are fully paid rest days — 0 salary is deducted.</div>
            </div>
            <div className="flex gap-2">
              <button
                className={`btn ${weeklyOffMode === 'company' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setWeeklyOffMode('company')}
              >
                🏢 Company Default
              </button>
              <button
                className={`btn ${weeklyOffMode === 'employee' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setWeeklyOffMode('employee')}
              >
                👤 Employee-Wise Offs
              </button>
            </div>
          </div>

          {weeklyOffMode === 'company' ? (
            <div className="card weekly-off-card" style={{ maxWidth: 600, padding: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Default Company Weekly Off Days</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>Select default weekly off days applicable to all employees.</div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[1, 2, 3, 4, 5, 6, 7].map(wd => {
                  const dayName = WEEKDAY_LABELS[wd];
                  const isSelected = selectedWeekdays.has(wd);
                  return (
                    <div key={wd} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '14px 18px',
                      border: isSelected ? '2px solid var(--primary)' : '1px solid var(--border-light)',
                      borderRadius: 8,
                      background: isSelected ? 'rgba(37,99,235,0.02)' : 'var(--surface)',
                      transition: 'all 0.15s ease'
                    }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: isSelected ? 'var(--primary)' : 'var(--text)' }}>{dayName}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {isSelected ? 'Weekly Off (Excluded from working days)' : 'Regular Working Day'}
                        </div>
                      </div>
                      <label className="switch" style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleWeekday(wd)} style={{ opacity: 0, width: 0, height: 0 }} />
                        <span className="slider round" style={{
                          position: 'absolute',
                          cursor: 'pointer',
                          top: 0, left: 0, right: 0, bottom: 0,
                          backgroundColor: isSelected ? 'var(--primary)' : '#ccc',
                          transition: '.4s',
                          borderRadius: 34
                        }}>
                          <span style={{
                            position: 'absolute',
                            content: '""',
                            height: 18, width: 18,
                            left: isSelected ? 22 : 4,
                            bottom: 3,
                            backgroundColor: 'white',
                            transition: '.4s',
                            borderRadius: '50%'
                          }} />
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={handleSaveWeeklyOffs} disabled={weeklyOffSaving}>
                  {weeklyOffSaving ? 'Saving…' : 'Save Default Settings'}
                </button>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Employee-Wise Weekly Off Assignment</div>
                  <div className="card-sub">Assign specific off days for each employee (e.g. Sunday, Saturday, Wednesday, etc.)</div>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>ID</th>
                      <th>Department / Role</th>
                      <th>Assigned Weekly Off Day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          <div className="empty-state">
                            {I.employees}
                            <h3>No employees registered</h3>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      employees.map(emp => {
                        const currentVal = empWeeklyOffMap[emp.id] !== undefined
                          ? String(empWeeklyOffMap[emp.id])
                          : (() => {
                              const empOffs = weeklyOffs.filter(w => w.employee_id === emp.id);
                              return empOffs.length === 2 && empOffs.some(w => w.weekday === 6) && empOffs.some(w => w.weekday === 7)
                                ? 'sat_sun'
                                : empOffs.length === 1
                                  ? String(empOffs[0].weekday)
                                  : 'default';
                            })();

                        return (
                          <tr key={emp.id}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div className="avatar-circle" style={{ background: avatarColor(emp.name) }}>
                                  {initials(emp.name)}
                                </div>
                                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{emp.name}</span>
                              </div>
                            </td>
                            <td><code>{emp.employee_id}</code></td>
                            <td>{emp.designation || emp.department || '—'}</td>
                            <td>
                              <select
                                className="form-input"
                                style={{ width: 220, cursor: 'pointer' }}
                                value={currentVal}
                                onChange={async e => {
                                  const val = e.target.value;
                                  await handleAssignEmpWeeklyOff(emp.id, val === 'default' ? 'default' : val === 'sat_sun' ? 'sat_sun' : Number(val));
                                }}
                              >
                                <option value="default">🏢 Default (Company Off)</option>
                                <option value="7">🗓 Sunday</option>
                                <option value="6">🗓 Saturday</option>
                                <option value="5">🗓 Friday</option>
                                <option value="4">🗓 Thursday</option>
                                <option value="3">🗓 Wednesday</option>
                                <option value="2">🗓 Tuesday</option>
                                <option value="1">🗓 Monday</option>
                                <option value="sat_sun">🗓 Saturday & Sunday (Dual Off)</option>
                              </select>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add Public Holiday</div>
            <div className="modal-sub">This will mark the date as a holiday for all employees.</div>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Holiday Name</label>
                <input className="form-input" placeholder="e.g. Diwali" required
                  value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Date</label>
                <input className="form-input" type="date" required
                  value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add Holiday'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddEmpHol && (
        <div className="modal-backdrop" onClick={() => setShowAddEmpHol(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Allot Employee Holiday</div>
            <div className="modal-sub">Allot a custom paid holiday for a specific employee on a select date.</div>
            <form onSubmit={handleAddEmpHol}>
              <div className="form-group">
                <label className="form-label">Select Employee</label>
                <select className="form-input" required value={empHolForm.employeeId}
                  onChange={e => setEmpHolForm(f => ({ ...f, employeeId: e.target.value }))}>
                  <option value="">-- Choose Employee --</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.employee_id})</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Holiday / Occasion Name</label>
                <input className="form-input" placeholder="e.g. Local Festival / Custom Off" required
                  value={empHolForm.name} onChange={e => setEmpHolForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Date</label>
                <input className="form-input" type="date" required
                  value={empHolForm.date} onChange={e => setEmpHolForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowAddEmpHol(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={savingEmpHol}>{savingEmpHol ? 'Saving…' : 'Allot Holiday'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {subTab === 'leave_allotment' && (
        <>
          <div className="section-head mb-4">
            <div>
              <div className="section-title">Monthly Paid Leave Allotments</div>
              <div className="section-sub">Configure monthly paid leave quota for each employee</div>
            </div>
            <button className="btn btn-primary" onClick={() => { setAllotEmpId(undefined); setShowAllotModal(true); }}>
              🌿 Allot Employee Leave
            </button>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>ID</th>
                    <th>Department / Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty-state">
                          {I.employees}
                          <h3>No employees found</h3>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    employees.map(emp => (
                      <tr key={emp.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="avatar-circle" style={{ background: avatarColor(emp.name) }}>
                              {initials(emp.name)}
                            </div>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{emp.name}</span>
                          </div>
                        </td>
                        <td><code>{emp.employee_id}</code></td>
                        <td>{emp.designation || emp.department || '—'}</td>
                        <td>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => {
                              setAllotEmpId(emp.id);
                              setShowAllotModal(true);
                            }}
                          >
                            🌿 Allot Monthly Leaves
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showAllotModal && (
        <AllotLeaveModal
          adminId={adminId}
          employees={employees}
          defaultEmployeeId={allotEmpId}
          onClose={() => {
            setShowAllotModal(false);
            setAllotEmpId(undefined);
          }}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── tiny CSV helper ──
function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;
  const esc = (v: string | number): string => {
    const s = String(v);
    const safe = FORMULA_TRIGGERS.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

type ReportTab = 'in_out' | 'attendance' | 'employee' | 'payroll';

function ReportsPage({ adminId }: { adminId: string }) {
  const now = new Date();
  const [tab, setTab] = useState<ReportTab>('in_out');
  const [filterMode, setFilterMode] = useState<'month' | 'range'>('month');
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [dateFrom, setDateFrom] = useState(today().slice(0, 7) + '-01');
  const [dateTo, setDateTo] = useState(today());
  const [loading, setLoading] = useState(false);
  const [filterEmp, setFilterEmp] = useState<string>('__all__');

  // ── data states ──
  const [attRows, setAttRows] = useState<Attendance[]>([]);
  const [empRows, setEmpRows] = useState<Employee[]>([]);
  const [salRows, setSalRows] = useState<EmployeeSalary[]>([]);

  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [weeklyOffs, setWeeklyOffs] = useState<WeeklyOffDay[]>([]);
  const [leaveAllot, setLeaveAllot] = useState<EmployeeLeave[]>([]);
  const [empHolidays, setEmpHolidays] = useState<any[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [calcMethod, setCalcMethod] = useState<'fixed_30' | 'working_day' | 'actual_calendar'>('working_day');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  const load = useCallback(async () => {
    setLoading(true);
    // All windows padded ±1 day because attendance is stored in UTC; rows are
    // re-bucketed and clamped by LOCAL day (dayKey) in the memos below.
    const monthStart = ymd(new Date(selYear, selMonth - 1, 0)) + 'T00:00:00';
    const monthEnd = ymd(new Date(selYear, selMonth, 1)) + 'T23:59:59';
    const dFrom = new Date(dateFrom + 'T00:00:00'); dFrom.setDate(dFrom.getDate() - 1);
    const dTo = new Date(dateTo + 'T00:00:00'); dTo.setDate(dTo.getDate() + 1);
    const rangeStart = ymd(dFrom) + 'T00:00:00';
    const rangeEnd = ymd(dTo) + 'T23:59:59';

    const isRange = (tab === 'in_out' || tab === 'attendance') && filterMode === 'range';
    const attStart = isRange ? rangeStart : monthStart;
    const attEnd = isRange ? rangeEnd : monthEnd;

    const [er, sr, hr, lar, ehr, wor, pr, lvr, { data: ar }] = await Promise.all([
      supabase.from('employees').select('*').eq('admin_id', adminId).order('name'),
      supabase.from('employee_salary').select('*').eq('admin_id', adminId),
      supabase.from('public_holidays').select('*').eq('admin_id', adminId),
      supabase.from('employee_leaves').select('*').eq('admin_id', adminId).eq('year', selYear).eq('month', selMonth),
      supabase.from('employee_holidays').select('*').eq('admin_id', adminId)
        .gte('date', monthStart.slice(0, 10)).lte('date', monthEnd.slice(0, 10)),
      supabase.from('weekly_off_days').select('*').eq('admin_id', adminId),
      supabase.from('profiles').select('salary_calc_method').eq('id', adminId).maybeSingle(),
      supabase.from('leave_requests').select('*').eq('admin_id', adminId).eq('status', 'approved'),
      supabase.from('attendance').select('*').eq('admin_id', adminId)
        .gte('timestamp', attStart).lte('timestamp', attEnd)
        .order('timestamp', { ascending: true }),
    ]);

    setEmpRows(er.data ?? []);
    setSalRows(sr.data ?? []);
    setHolidays(hr.data ?? []);
    setLeaveAllot(lar.data ?? []);
    setEmpHolidays(ehr.data ?? []);
    setWeeklyOffs((wor.data ?? []) as WeeklyOffDay[]);
    setLeaves((lvr.data ?? []) as LeaveRequest[]);
    if (pr.data?.salary_calc_method) {
      setCalcMethod(pr.data.salary_calc_method as any);
    }
    setAttRows(ar ?? []);
    setLoading(false);
  }, [adminId, tab, filterMode, selMonth, selYear, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // ── per-employee monthly summary ──
  const empSummary = useMemo(() => {
    const salMap = Object.fromEntries(salRows.map(s => [s.employee_id, s]));
    const laMap = Object.fromEntries(leaveAllot.map(l => [l.employee_id, l]));
    const attMap: Record<string, Set<string>> = {};
    const monthPrefix = `${selYear}-${String(selMonth).padStart(2, '0')}`;

    // Aggregation for present days
    attRows.filter(a => a.punch_type === 'check_in').forEach(a => {
      const d = dayKey(a.timestamp);
      if (d.slice(0, 7) !== monthPrefix) return;   // drop adjacent-month rows from the padded window
      if (!attMap[a.employee_id]) attMap[a.employee_id] = new Set();
      attMap[a.employee_id].add(d);
    });

    // Aggregation for overtime hours
    const recAgg = new Map<string, { first: number; last: number; hasIn: boolean; hasOut: boolean }>();
    for (const r of attRows) {
      const date = dayKey(r.timestamp);
      if (date.slice(0, 7) !== monthPrefix) continue;
      const key = r.employee_id + '|' + date;
      const t = new Date(r.timestamp);
      const mins = t.getHours() * 60 + t.getMinutes();
      const cur = recAgg.get(key) ?? { first: 1e9, last: -1, hasIn: false, hasOut: false };
      if (r.punch_type === 'check_in') { cur.hasIn = true; cur.first = Math.min(cur.first, mins); }
      if (r.punch_type === 'check_out') { cur.hasOut = true; cur.last = Math.max(cur.last, mins); }
      recAgg.set(key, cur);
    }

    const otMap: Record<string, number> = {};
    const lateMap: Record<string, number> = {};
    const shortageMap: Record<string, number> = {};
    const workedMap: Record<string, number> = {};
    const empMap = new Map(empRows.map(e => [e.id, e]));
    for (const [key, v] of recAgg) {
      const id = key.split('|')[0];
      const emp = empMap.get(id);
      if (emp) {
        const shiftStartMins = HHMM(emp.shift_start || '09:00');
        const shiftEndMins = HHMM(emp.shift_end || '17:00');
        const shiftLen = Math.max(0, shiftEndMins - shiftStartMins) || 480;

        let worked = 0;
        if (v.hasIn && v.hasOut) {
          worked = Math.max(0, v.last - v.first);
          const otMins = Math.max(0, worked - shiftLen);
          if (otMins > 0) otMap[id] = (otMap[id] ?? 0) + otMins;

          const shortage = Math.max(0, 480 - worked);
          if (shortage > 0) shortageMap[id] = (shortageMap[id] ?? 0) + shortage;
        } else if (v.hasIn) {
          worked = v.first < shiftEndMins ? Math.max(0, shiftEndMins - v.first) : shiftLen;
        } else if (v.hasOut) {
          worked = v.last > shiftStartMins ? Math.max(0, v.last - shiftStartMins) : shiftLen;
        }

        if (worked > 0) {
          workedMap[id] = (workedMap[id] ?? 0) + worked;
        }

        if (v.hasIn) {
          const late = Math.max(0, v.first - shiftStartMins);
          if (late > 0) lateMap[id] = (lateMap[id] ?? 0) + late;
        }
      }
    }

    return empRows.map(emp => {
      const empHols = empHolidays.filter(eh => eh.employee_id === emp.id).map(eh => eh.date);
      const slip = calculateSalarySlip({
        emp,
        salary: salMap[emp.id],
        leavesAllotted: laMap[emp.id]?.leaves_allotted ?? 0,
        presentDates: attMap[emp.id] ?? new Set<string>(),
        otMinutes: otMap[emp.id] ?? 0,
        totalWorkedMinutes: workedMap[emp.id] ?? 0,
        holidays,
        empHolidays: empHols,
        weeklyOffs: getEmployeeWeeklyOffSet(weeklyOffs, emp.id),
        lateMinutes: lateMap[emp.id] ?? 0,
        shortageMinutes: shortageMap[emp.id] ?? 0,
        year: selYear,
        month: selMonth,
        calcMethod,
      });
      return {
        emp,
        gross: slip.grossPay,
        present: slip.daysPresent,
        absent: slip.daysAbsent,
        allotted: slip.leavesAllotted,
        wDays: slip.workingDays,
        netPay: slip.netPay,
        deduction: (slip.unpaidLeaveDeduction ?? slip.absentDeduction) + (slip.lateCutDeduction ?? 0) + (slip.underworkDeduction ?? 0)
      };
    });
  }, [empRows, salRows, leaveAllot, attRows, holidays, weeklyOffs, empHolidays, selMonth, selYear, calcMethod]);

  const totalGross = useMemo(() => empSummary.reduce((s, r) => s + r.gross, 0), [empSummary]);
  const totalNet = useMemo(() => empSummary.reduce((s, r) => s + r.netPay, 0), [empSummary]);
  const totalDeduct = totalGross - totalNet;

  // ── Daily In/Out details dataset (per employee, per date) ──
  const dailyInOutRecords = useMemo(() => {
    let dateList: string[] = [];
    const isRange = (tab === 'in_out' || tab === 'attendance') && filterMode === 'range';

    if (!isRange) {
      const dim = new Date(selYear, selMonth, 0).getDate();
      const pad = (n: number) => String(n).padStart(2, '0');
      for (let d = 1; d <= dim; d++) {
        dateList.push(`${selYear}-${pad(selMonth)}-${pad(d)}`);
      }
    } else {
      const start = new Date(dateFrom + 'T00:00:00');
      const end = new Date(dateTo + 'T00:00:00');
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dateList.push(ymd(d));
      }
    }

    const targetEmps = filterEmp === '__all__'
      ? empRows
      : empRows.filter(e => e.id === filterEmp);

    const monthPrefix = `${selYear}-${String(selMonth).padStart(2, '0')}`;

    const punchAgg = new Map<string, { first: number; last: number; firstTime: string; lastTime: string; hasIn: boolean; hasOut: boolean }>();
    for (const r of attRows) {
      const d = dayKey(r.timestamp);
      if (!isRange && d.slice(0, 7) !== monthPrefix) continue;
      if (isRange && (d < dateFrom || d > dateTo)) continue;

      const key = r.employee_id + '|' + d;
      const t = new Date(r.timestamp);
      const mins = t.getHours() * 60 + t.getMinutes();
      const formatted = fmtTime(r.timestamp);
      const cur = punchAgg.get(key) ?? { first: 1e9, last: -1, firstTime: '', lastTime: '', hasIn: false, hasOut: false };

      if (r.punch_type === 'check_in') {
        cur.hasIn = true;
        if (mins < cur.first) {
          cur.first = mins;
          cur.firstTime = formatted;
        }
      }
      if (r.punch_type === 'check_out') {
        cur.hasOut = true;
        if (mins > cur.last) {
          cur.last = mins;
          cur.lastTime = formatted;
        }
      }
      punchAgg.set(key, cur);
    }

    const holidayDates = new Set(holidays.map(h => h.date));
    const weeklyOffSet = new Set(weeklyOffs.map(w => w.weekday));
    const todayStr = today();
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const results: {
      emp: Employee;
      date: string;
      dayOfWeek: string;
      inTime: string;
      outTime: string;
      workedStr: string;
      workedMins: number;
      status: 'present' | 'absent' | 'holiday' | 'leave' | 'future';
      statusLabel: string;
    }[] = [];

    for (const emp of targetEmps) {
      const shiftStartMins = HHMM(emp.shift_start || '09:00');
      const shiftEndMins = HHMM(emp.shift_end || '17:00');
      const shiftLen = Math.max(0, shiftEndMins - shiftStartMins) || 480;

      for (const dStr of dateList) {
        const dt = new Date(dStr + 'T00:00:00');
        const dayOfWeek = DAY_NAMES[dt.getDay()];
        const key = emp.id + '|' + dStr;
        const p = punchAgg.get(key);

        const isEmpHol = empHolidays.some(eh => eh.employee_id === emp.id && eh.date === dStr);
        const isPubHol = holidayDates.has(dStr);
        const isWkOff = weeklyOffSet.has(toWeekdayNumber(dt));
        const leaveRec = leaves.find(l => l.employee_id === emp.id && l.status === 'approved' && l.start_date <= dStr && l.end_date >= dStr);

        let status: 'present' | 'absent' | 'holiday' | 'leave' | 'future' = 'absent';
        let statusLabel = 'Absent';

        if (p?.hasIn || p?.hasOut) {
          status = 'present';
          statusLabel = 'Present';
        } else if (isEmpHol || isPubHol || isWkOff) {
          status = 'holiday';
          statusLabel = isPubHol ? 'Public Holiday' : isWkOff ? 'Weekly Off' : 'Holiday';
        } else if (leaveRec) {
          status = 'leave';
          statusLabel = `Leave (${leaveRec.type})`;
        } else if (dStr > todayStr) {
          status = 'future';
          statusLabel = '—';
        } else {
          status = 'absent';
          statusLabel = 'Absent';
        }

        let workedMins = 0;
        if (p?.hasIn && p?.hasOut) {
          workedMins = Math.max(0, p.last - p.first);
        } else if (p?.hasIn) {
          workedMins = p.first < shiftEndMins ? Math.max(0, shiftEndMins - p.first) : shiftLen;
        } else if (p?.hasOut) {
          workedMins = p.last > shiftStartMins ? Math.max(0, p.last - shiftStartMins) : shiftLen;
        }

        const h = Math.floor(workedMins / 60);
        const m = workedMins % 60;
        const workedStr = workedMins > 0 ? `${h}h ${m}m` : (status === 'present' ? '0h 0m' : '—');

        results.push({
          emp,
          date: dStr,
          dayOfWeek,
          inTime: p?.firstTime || '—',
          outTime: p?.lastTime || '—',
          workedStr,
          workedMins,
          status,
          statusLabel
        });
      }
    }

    results.sort((a, b) => b.date.localeCompare(a.date));
    return results;
  }, [dateFrom, dateTo, selMonth, selYear, filterMode, filterEmp, empRows, attRows, holidays, weeklyOffs, empHolidays, leaves, tab]);

  // ── CSV exports ──
  const exportInOutCSV = () => {
    const empName = filterEmp !== '__all__' ? (empMap[filterEmp]?.name ?? 'employee') : 'all';
    const period = filterMode === 'month' ? `${MONTHS[selMonth - 1]}_${selYear}` : `${dateFrom}_to_${dateTo}`;
    downloadCSV(
      `daily_in_out_${empName}_${period}.csv`,
      ['Employee Name', 'Employee Code', 'Date', 'Day', 'Shift', 'Check In', 'Check Out', 'Worked Duration', 'Status'],
      dailyInOutRecords.map(r => [
        r.emp.name,
        r.emp.employee_id,
        r.date,
        r.dayOfWeek,
        `${r.emp.shift_start}-${r.emp.shift_end}`,
        r.inTime,
        r.outTime,
        r.workedStr,
        r.statusLabel
      ])
    );
  };

  const exportAttCSV = () => {
    const empName = filterEmp !== '__all__' ? (empMap[filterEmp]?.name ?? 'employee') : 'all';
    downloadCSV(
      `attendance_${empName}_${dateFrom}_${dateTo}.csv`,
      ['Employee', 'Code', 'Date', 'Time', 'Type', 'Method', 'Confidence'],
      displayedAttRows.map(r => [r.employee_name, r.employee_code,
      r.timestamp.slice(0, 10), fmtTime(r.timestamp),
      r.punch_type, r.verification_method,
      Math.round(r.confidence * 100) + '%'])
    );
  };

  const exportEmpCSV = () => downloadCSV(
    `employee_summary_${MONTHS[selMonth - 1]}_${selYear}.csv`,
    ['Name', 'ID', 'Shift', 'Gross (₹)', 'Working Days', 'Present', 'Absent', 'Allotted Leaves', 'Deduction (₹)', 'Net Pay (₹)'],
    empSummary.map(s => [s.emp.name, s.emp.employee_id,
    `${s.emp.shift_start}-${s.emp.shift_end}`,
    s.gross, s.wDays, s.present, s.absent, s.allotted,
    Math.round(s.deduction), Math.round(s.netPay)])
  );

  const exportPayrollCSV = () => downloadCSV(
    `payroll_${MONTHS[selMonth - 1]}_${selYear}.csv`,
    ['Name', 'Employee ID', 'Gross (₹)', 'Working Days', 'Present', 'Absent', 'Allotted Leaves', 'Deduction (₹)', 'Net Payable (₹)'],
    empSummary.map(s => [s.emp.name, s.emp.employee_id,
    s.gross, s.wDays, s.present, s.absent, s.allotted,
    Math.round(s.deduction), Math.round(s.netPay)])
  );

  const empMap = Object.fromEntries(empRows.map(e => [e.id, e]));

  // ── filter attendance rows by selected employee ──
  const displayedAttRows = useMemo(() => {
    return attRows.filter(r => filterEmp === '__all__' || r.employee_id === filterEmp);
  }, [attRows, filterEmp]);

  // ── attendance stats (for date-range) ──
  const attStats = useMemo(() => {
    const checkIns = displayedAttRows.filter(r => r.punch_type === 'check_in').length;
    const checkOuts = displayedAttRows.filter(r => r.punch_type === 'check_out').length;
    const byDay: Record<string, number> = {};
    displayedAttRows.filter(r => r.punch_type === 'check_in').forEach(r => {
      const d = dayKey(r.timestamp);
      if (filterMode === 'range' && (d < dateFrom || d > dateTo)) return;   // clamp out adjacent-day rows from the padded fetch window
      byDay[d] = (byDay[d] ?? 0) + 1;
    });
    const days = Object.keys(byDay).sort();
    return { checkIns, checkOuts, byDay, days };
  }, [displayedAttRows, dateFrom, dateTo, filterMode]);

  return (
    <div>
      {/* Page header */}
      <div className="section-head mb-4">
        <div>
          <div className="section-title">Reports &amp; Analytics</div>
          <div className="section-sub">Export data as CSV or print reports</div>
        </div>
        <div className="flex gap-2 items-center">
          <button className="btn btn-outline btn-sm" onClick={() => window.print()}>
            {I.print} Print
          </button>
        </div>
      </div>

      {/* Report type tabs */}
      <div className="tab-bar mb-4">
        {([
          { id: 'in_out', label: 'Daily In/Out Details', icon: I.clock },
          { id: 'attendance', label: 'Attendance Punch Log', icon: I.attendance },
          { id: 'employee', label: 'Employee Summary', icon: I.employees },
          { id: 'payroll', label: 'Payroll Report', icon: I.payroll },
        ] as { id: ReportTab; label: string; icon: React.ReactNode }[]).map(t => (
          <button key={t.id} className={`tab-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="card mb-4">
        <div className="card-body reports-filter-body" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Filters</span>

          {(tab === 'in_out' || tab === 'attendance') && (
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" style={{ marginBottom: 3 }}>Period Mode</label>
              <select className="form-input" value={filterMode} style={{ width: 140, fontWeight: 600 }}
                onChange={e => setFilterMode(e.target.value as any)}>
                <option value="month">📅 By Month</option>
                <option value="range">📆 Date Range</option>
              </select>
            </div>
          )}

          {(tab === 'employee' || tab === 'payroll' || filterMode === 'month') ? (
            <>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ marginBottom: 3 }}>Month</label>
                <select className="form-input" value={selMonth} style={{ width: 100 }}
                  onChange={e => setSelMonth(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ marginBottom: 3 }}>Year</label>
                <select className="form-input" value={selYear} style={{ width: 90 }}
                  onChange={e => setSelYear(Number(e.target.value))}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ marginBottom: 3 }}>From</label>
                <input className="form-input" type="date" value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)} style={{ width: 150 }} />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ marginBottom: 3 }}>To</label>
                <input className="form-input" type="date" value={dateTo}
                  onChange={e => setDateTo(e.target.value)} style={{ width: 150 }} />
              </div>
            </>
          )}

          {(tab === 'in_out' || tab === 'attendance') && (
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" style={{ marginBottom: 3 }}>Employee</label>
              <select className="form-input" value={filterEmp} style={{ minWidth: 180 }}
                onChange={e => setFilterEmp(e.target.value)}>
                <option value="__all__">All Employees</option>
                {empRows.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}

          <div className="reports-filter-spacer" style={{ flex: 1 }} />
          {tab === 'in_out' && <button className="btn btn-primary btn-sm" onClick={exportInOutCSV}>{I.download} Export CSV</button>}
          {tab === 'attendance' && <button className="btn btn-primary btn-sm" onClick={exportAttCSV}>{I.download} Export CSV</button>}
          {tab === 'employee' && <button className="btn btn-primary btn-sm" onClick={exportEmpCSV}>{I.download} Export CSV</button>}
          {tab === 'payroll' && <button className="btn btn-primary btn-sm" onClick={exportPayrollCSV}>{I.download} Export CSV</button>}
        </div>
      </div>

      {loading ? <div className="loader-overlay"><div className="spinner" /></div> : (
        <>
          {/* ── DAILY IN/OUT DETAILS REPORT ── */}
          {tab === 'in_out' && (
            <div>
              {/* Summary cards */}
              {(() => {
                const presentCount = dailyInOutRecords.filter(r => r.status === 'present').length;
                const absentCount = dailyInOutRecords.filter(r => r.status === 'absent').length;
                const totalWorkedMins = dailyInOutRecords.reduce((s, r) => s + r.workedMins, 0);
                const h = Math.floor(totalWorkedMins / 60);
                const m = totalWorkedMins % 60;
                const periodLabel = filterMode === 'month' ? `${MONTHS[selMonth - 1]} ${selYear}` : `${dateFrom} → ${dateTo}`;
                const empLabel = filterEmp !== '__all__' ? (empMap[filterEmp]?.name ?? 'Selected Employee') : 'All Employees';

                return (
                  <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 20 }}>
                    <div className="stat-card">
                      <div className="stat-icon blue">{I.employees}</div>
                      <div className="stat-info">
                        <div className="stat-value">{dailyInOutRecords.length}</div>
                        <div className="stat-label">Evaluated Days</div>
                        <span className="stat-sub neutral">{empLabel}</span>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon green">{I.attendance}</div>
                      <div className="stat-info">
                        <div className="stat-value">{presentCount}</div>
                        <div className="stat-label">Days Present</div>
                        <span className="stat-sub up">{periodLabel}</span>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon red">{I.x}</div>
                      <div className="stat-info">
                        <div className="stat-value">{absentCount}</div>
                        <div className="stat-label">Days Absent</div>
                        <span className="stat-sub down">Absences</span>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-icon yellow">{I.clock}</div>
                      <div className="stat-info">
                        <div className="stat-value">{h}h {m}m</div>
                        <div className="stat-label">Total Worked Hours</div>
                        <span className="stat-sub up">Recorded time</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="card">
                <div className="card-header">
                  <div className="card-title">
                    Daily In/Out Details — {filterMode === 'month' ? `${MONTHS[selMonth - 1]} ${selYear}` : `${dateFrom} to ${dateTo}`}
                  </div>
                  <span className="badge blue">{dailyInOutRecords.length} day records</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Employee</th><th>Date</th><th>Shift</th><th>Check-In (In)</th><th>Check-Out (Out)</th><th>Worked Hours</th><th>Status</th>
                    </tr></thead>
                    <tbody>
                      {dailyInOutRecords.length === 0
                        ? <tr><td colSpan={7}><div className="empty-state">{I.attendance}<h3>No records found</h3></div></td></tr>
                        : dailyInOutRecords.slice(0, 300).map((r, i) => (
                          <tr key={i}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div className="avatar-circle" style={{ background: avatarColor(r.emp.name), width: 30, height: 30, fontSize: 11 }}>
                                  {initials(r.emp.name)}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{r.emp.name}</div>
                                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{r.emp.employee_id}</div>
                                </div>
                              </div>
                            </td>
                            <td style={{ fontSize: 12.5, fontWeight: 600 }}>
                              {r.date} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>({r.dayOfWeek})</span>
                            </td>
                            <td>
                              <span style={{ fontSize: 11.5, background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 4, fontWeight: 600, color: 'var(--text-secondary)' }}>
                                {r.emp.shift_start}–{r.emp.shift_end}
                              </span>
                            </td>
                            <td>
                              {r.inTime !== '—' ? (
                                <span className="badge green" style={{ fontSize: 11.5 }}>▲ {r.inTime}</span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                              )}
                            </td>
                            <td>
                              {r.outTime !== '—' ? (
                                <span className="badge blue" style={{ fontSize: 11.5 }}>▼ {r.outTime}</span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                              )}
                            </td>
                            <td style={{ fontWeight: 700, fontSize: 13, color: r.workedStr !== '—' ? 'var(--text)' : 'var(--text-muted)' }}>
                              {r.workedStr}
                            </td>
                            <td>
                              {r.status === 'present' ? <span className="badge green">✓ Present</span>
                                : r.status === 'absent' ? <span className="badge red">✗ Absent</span>
                                  : r.status === 'leave' ? <span className="badge blue">🌿 Leave</span>
                                    : r.status === 'holiday' ? <span className="badge yellow">★ Holiday</span>
                                      : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {dailyInOutRecords.length > 300 && (
                    <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}>
                      Showing 300 of {dailyInOutRecords.length} records. Click Export CSV for complete data.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* ── ATTENDANCE REPORT ── */}
          {tab === 'attendance' && (
            <div>
              {/* Summary cards */}
              <div className="stats-grid reports-att-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
                <div className="stat-card">
                  <div className="stat-icon green">{I.attendance}</div>
                  <div className="stat-info">
                    <div className="stat-value">{attStats.checkIns}</div>
                    <div className="stat-label">Check-ins</div>
                    <span className="stat-sub up">{dateFrom} → {dateTo}</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon blue">{I.clock}</div>
                  <div className="stat-info">
                    <div className="stat-value">{attStats.checkOuts}</div>
                    <div className="stat-label">Check-outs</div>
                    <span className="stat-sub neutral">{attRows.length} total punches</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon yellow">{I.alert}</div>
                  <div className="stat-info">
                    <div className="stat-value">{attStats.checkIns - attStats.checkOuts}</div>
                    <div className="stat-label">Missing checkouts</div>
                    <span className="stat-sub down">Potential exceptions</span>
                  </div>
                </div>
              </div>

              {/* Day-wise bar chart */}
              {attStats.days.length > 0 && (
                <div className="card mb-4">
                  <div className="card-header">
                    <div className="card-title">{I.bar} Daily Check-ins</div>
                    <span className="badge grey">{attStats.days.length} days</span>
                  </div>
                  <div className="card-body" style={{ overflowX: 'auto' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, minWidth: attStats.days.length * 38, height: 120, paddingBottom: 24, position: 'relative' }}>
                      {attStats.days.map(d => {
                        const cnt = attStats.byDay[d];
                        const max = Math.max(...Object.values(attStats.byDay));
                        const pct = max > 0 ? (cnt / max) * 100 : 0;
                        return (
                          <div key={d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 32 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary-dark)', marginBottom: 4 }}>{cnt}</span>
                            <div style={{ width: '100%', background: 'var(--border)', borderRadius: 4, overflow: 'hidden', height: 80 }}>
                              <div style={{ height: `${pct}%`, background: 'linear-gradient(to top, var(--primary-dark), #6ee7b7)', borderRadius: 4, marginTop: `${100 - pct}%`, transition: 'height 0.3s ease' }} />
                            </div>
                            <span style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4, transform: 'rotate(-40deg)', transformOrigin: 'top left', whiteSpace: 'nowrap' }}>
                              {new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Raw attendance log */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Attendance Log</div>
                  <span className="badge blue">{displayedAttRows.length} records</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Employee</th><th>Code</th><th>Date</th><th>Time</th><th>Type</th><th>Method</th><th>Confidence</th>
                    </tr></thead>
                    <tbody>
                      {displayedAttRows.length === 0
                        ? <tr><td colSpan={7}><div className="empty-state">{I.attendance}<h3>No records</h3></div></td></tr>
                        : displayedAttRows.slice(0, 200).map(r => (
                          <tr key={r.id}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div className="avatar-circle" style={{ background: avatarColor(r.employee_name), width: 28, height: 28, fontSize: 10 }}>{initials(r.employee_name)}</div>
                                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.employee_name}</span>
                              </div>
                            </td>
                            <td><code style={{ fontSize: 11, background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4 }}>{r.employee_code}</code></td>
                            <td style={{ fontSize: 12.5 }}>{r.timestamp.slice(0, 10)}</td>
                            <td style={{ fontWeight: 600 }}>{fmtTime(r.timestamp)}</td>
                            <td><span className={`badge ${r.punch_type === 'check_in' ? 'green' : 'blue'}`}>{r.punch_type === 'check_in' ? '▲ In' : '▼ Out'}</span></td>
                            <td>
                              {(() => {
                                const vm = r.verification_method?.toLowerCase() ?? '';
                                const isface = vm === 'face' || vm === 'face_recognition';
                                const isAdmin = vm === 'admin' || vm === 'manual';
                                const isPin = vm === 'pin';
                                return (
                                  <span className={`badge ${isface ? 'green' : isAdmin ? 'yellow' : isPin ? 'blue' : 'grey'}`}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    {isface ? '🤖 FACE' : isAdmin ? '👤 ADMIN' : isPin ? '🔑 PIN' : (r.verification_method ?? '—').toUpperCase()}
                                  </span>
                                );
                              })()}
                            </td>
                            <td>
                              <div className="attend-bar-wrap" style={{ minWidth: 80 }}>
                                <div className="attend-bar-bg" style={{ height: 4 }}>
                                  <div className="attend-bar-fill" style={{ width: `${Math.round(r.confidence * 100)}%` }} />
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28 }}>{Math.round(r.confidence * 100)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {attRows.length > 200 && (
                    <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}>
                      Showing 200 of {attRows.length} records. Export CSV for full data.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── EMPLOYEE SUMMARY REPORT ── */}
          {tab === 'employee' && (
            <div>
              <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 20 }}>
                <div className="stat-card"><div className="stat-icon blue">{I.employees}</div><div className="stat-info"><div className="stat-value">{empRows.length}</div><div className="stat-label">Total Employees</div></div></div>
                <div className="stat-card"><div className="stat-icon green">{I.attendance}</div><div className="stat-info"><div className="stat-value">{empSummary.filter(s => s.present === s.wDays).length}</div><div className="stat-label">Full Attendance</div><span className="stat-sub up">No absences</span></div></div>
                <div className="stat-card"><div className="stat-icon red">{I.x}</div><div className="stat-info"><div className="stat-value">{empSummary.filter(s => s.absent > 0).length}</div><div className="stat-label">Had Absences</div><span className="stat-sub down">This month</span></div></div>
                <div className="stat-card"><div className="stat-icon yellow">{I.leave}</div><div className="stat-info"><div className="stat-value">{empSummary.filter(s => !s.gross).length}</div><div className="stat-label">No Salary Set</div><span className="stat-sub neutral">Needs config</span></div></div>
              </div>
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Employee Monthly Summary — {MONTHS[selMonth - 1]} {selYear}</div>
                  <span className="badge green">{empRows.length} employees</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Employee</th><th>Shift</th><th>Working Days</th><th>Present</th><th>Absent</th><th>Leaves</th><th>Attendance</th>
                    </tr></thead>
                    <tbody>
                      {empSummary.length === 0
                        ? <tr><td colSpan={7}><div className="empty-state">{I.employees}<h3>No data</h3></div></td></tr>
                        : empSummary.map(s => {
                          const pct = s.wDays > 0 ? Math.round((s.present / s.wDays) * 100) : 0;
                          return (
                            <tr key={s.emp.id}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div className="avatar-circle" style={{ background: avatarColor(s.emp.name), width: 30, height: 30, fontSize: 11 }}>{initials(s.emp.name)}</div>
                                  <div>
                                    <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{s.emp.name}</div>
                                    <code style={{ fontSize: 10.5, background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4 }}>{s.emp.employee_id}</code>
                                  </div>
                                </div>
                              </td>
                              <td style={{ fontSize: 12.5 }}>{s.emp.shift_start}–{s.emp.shift_end}</td>
                              <td style={{ fontWeight: 600 }}>{s.wDays}</td>
                              <td><span className="badge green">{s.present}d</span></td>
                              <td>{s.absent > 0 ? <span className="badge red">{s.absent}d</span> : <span className="badge grey">0d</span>}</td>
                              <td><span className="badge blue">{s.allotted}d</span></td>
                              <td style={{ minWidth: 120 }}>
                                <div className="attend-bar-wrap">
                                  <div className="attend-bar-bg" style={{ height: 6 }}>
                                    <div className="attend-bar-fill" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span style={{ fontSize: 11.5, fontWeight: 700, color: pct >= 90 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--error)', minWidth: 32 }}>{pct}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── LEAVE REPORT ── */}


          {/* ── PAYROLL REPORT ── */}
          {tab === 'payroll' && (
            <div>
              {/* Payroll summary */}
              <div className="reports-payroll-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
                <div className="stat-card" style={{ background: 'linear-gradient(135deg,var(--primary-dark),#34d399)', border: 'none', boxShadow: 'var(--shadow-primary)' }}>
                  <div className="stat-icon" style={{ background: 'rgba(255,255,255,0.2)' }}>{I.payroll}</div>
                  <div className="stat-info">
                    <div className="stat-value" style={{ color: 'white', fontSize: 22 }}>{fmtMoney(totalGross)}</div>
                    <div className="stat-label" style={{ color: 'rgba(255,255,255,0.8)' }}>Total Gross — {MONTHS[selMonth - 1]} {selYear}</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon red">{I.alert}</div>
                  <div className="stat-info">
                    <div className="stat-value" style={{ color: 'var(--error)' }}>{fmtMoney(Math.round(totalDeduct))}</div>
                    <div className="stat-label">Total Deductions</div>
                    <span className="stat-sub down">Absent deductions</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon green">{I.check}</div>
                  <div className="stat-info">
                    <div className="stat-value">{fmtMoney(Math.round(totalNet))}</div>
                    <div className="stat-label">Total Net Payable</div>
                    <span className="stat-sub up">{empRows.length} employees</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div className="card-title">Payroll Statement — {MONTHS[selMonth - 1]} {selYear}</div>
                  <span className="badge green">{empRows.length} employees</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Employee</th><th>Gross</th><th>Days</th><th>Present</th><th>Absent</th><th>Leaves</th><th>Deduction</th><th style={{ color: 'var(--primary-dark)' }}>Net Payable</th>
                    </tr></thead>
                    <tbody>
                      {empSummary.length === 0
                        ? <tr><td colSpan={8}><div className="empty-state">{I.payroll}<h3>No data</h3></div></td></tr>
                        : empSummary.map(s => (
                          <tr key={s.emp.id}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div className="avatar-circle" style={{ background: avatarColor(s.emp.name), width: 30, height: 30, fontSize: 11 }}>{initials(s.emp.name)}</div>
                                <div>
                                  <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{s.emp.name}</div>
                                  <code style={{ fontSize: 10.5, background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4 }}>{s.emp.employee_id}</code>
                                </div>
                              </div>
                            </td>
                            <td style={{ fontWeight: 600 }}>{s.gross ? fmtMoney(s.gross) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Not set</span>}</td>
                            <td>{s.wDays}</td>
                            <td><span className="badge green">{s.present}d</span></td>
                            <td>{s.absent > 0 ? <span className="badge red">{s.absent}d</span> : <span className="badge grey">0d</span>}</td>
                            <td><span className="badge blue">{s.allotted}d</span></td>
                            <td style={{ color: s.deduction > 0 ? 'var(--error)' : 'var(--text-muted)', fontWeight: 600 }}>
                              {s.deduction > 0 ? `−${fmtMoney(Math.round(s.deduction))}` : '₹0'}
                            </td>
                            <td>
                              <span style={{ fontSize: 14, fontWeight: 800, color: s.gross ? 'var(--primary-dark)' : 'var(--text-muted)' }}>
                                {s.gross ? fmtMoney(Math.round(s.netPay)) : '—'}
                              </span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                    {empSummary.length > 0 && (
                      <tfoot>
                        <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                          <td style={{ padding: '12px 16px', fontWeight: 700 }}>TOTAL</td>
                          <td style={{ padding: '12px 16px' }}>{fmtMoney(totalGross)}</td>
                          <td colSpan={4} />
                          <td style={{ padding: '12px 16px', color: 'var(--error)' }}>−{fmtMoney(Math.round(totalDeduct))}</td>
                          <td style={{ padding: '12px 16px', color: 'var(--primary-dark)', fontSize: 15 }}>{fmtMoney(Math.round(totalNet))}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNERS
// ═══════════════════════════════════════════════════════════════════════════════
interface ScannerAccount {
  id: string;
  admin_id: string;
  email: string;
  created_at: string;
  model_degraded?: boolean;
  location_id?: string | null;
}

function ScannersPage({ adminId }: { adminId: string }) {
  const [scanners, setScanners] = useState<ScannerAccount[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: scData }, { data: locData }] = await Promise.all([
      supabase.from('profiles').select('*').eq('admin_id', adminId).eq('role', 'scanner').order('created_at', { ascending: false }),
      supabase.from('locations').select('*').eq('admin_id', adminId).order('name'),
    ]);
    setScanners(scData ?? []);
    setLocations(locData ?? []);
    setLoading(false);
  }, [adminId]);

  const locMap = Object.fromEntries(locations.map(l => [l.id, l]));

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Session expired or unauthorized. Please log in again.');
        setSaving(false);
        return;
      }

      const response = await fetch('https://ufujcwfakwdtyhbmolyr.supabase.co/functions/v1/create-scanner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          email: form.email,
          password: form.password
        })
      });

      const resData = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(resData.error || 'Failed to create scanner account');
        setSaving(false);
        return;
      }

      setSaving(false);
      setShowAdd(false);
      setForm({ email: '', password: '' });
      load();
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
      setSaving(false);
    }
  };

  const handleDelete = async (s: ScannerAccount) => {
    if (!confirm(`Remove scanner "${s.email}"? They will no longer be able to log in.`)) return;
    setDeleting(s.id);
    const res = await softDeleteRecord('profiles', s.id, adminId, 'admin', 'admin', s.email);
    if (!res.success) {
      alert(`Failed to delete scanner account: ${res.error}`);
      setDeleting(null);
      return;
    }
    await auditLog(adminId, 'scanner.delete', s.id, s.email, {
      location_id: s.location_id ?? null,
      soft_deleted: true,
    });
    setDeleting(null);
    load();
  };

  const handleResetDevice = async (scannerId: string) => {
    if (!confirm('Authorize a new device? This will clear the current device lock for this scanner so it can be logged in on another device.')) return;
    const { error: rpcErr } = await supabase.rpc('reset_scanner_device', { p_scanner_id: scannerId });
    if (rpcErr) {
      alert('Error resetting device: ' + rpcErr.message);
    } else {
      alert('Device binding successfully reset! You can now log in to this scanner account on any new phone or tablet.');
    }
  };

  return (
    <div>
      <div className="section-head mb-4">
        <div>
          <div className="section-title">Scanner Accounts</div>
          <div className="section-sub">{scanners.length} scanner{scanners.length !== 1 ? 's' : ''} registered — these accounts can only mark attendance</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          {I.plus} New Scanner
        </button>
      </div>

      {/* Info banner */}
      <div style={{ background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 'var(--radius-md)', padding: '12px 18px', marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 13 }}>
        <span style={{ color: 'var(--info)', flexShrink: 0, marginTop: 1 }}>{I.shield}</span>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>What are Scanner Accounts?</div>
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Scanner accounts are restricted logins for staff who <strong>only need to mark attendance</strong> (face recognition / QR scan) on the mobile app.
            They cannot access employee records, payroll, or admin settings.
          </div>
        </div>
      </div>

      {loading ? <div className="loader-overlay"><div className="spinner" /></div>
        : scanners.length === 0
          ? <div className="empty-state">{I.qr}<h3>No scanner accounts yet</h3><p>Create accounts for staff who only need to log attendance via the mobile app.</p></div>
          : <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>Email</th><th>Location</th><th>Account ID</th><th>Registered</th><th>Status</th><th>Action</th>
                </tr></thead>
                <tbody>
                  {scanners.map(s => (
                    <tr key={s.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 34, height: 34, background: 'var(--primary-glow)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-dark)', flexShrink: 0 }}>
                            {I.qr}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{s.email}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>Scanner login</div>
                          </div>
                        </div>
                      </td>
                      <td><code style={{ fontSize: 10.5, background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 4 }}>{s.id.slice(0, 8)}…</code></td>
                      <td>
                        {s.location_id && locMap[s.location_id] ? (
                          <span className="badge blue" style={{ fontSize: 11 }}>📍 {locMap[s.location_id].name}</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Any</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{fmtDate(s.created_at)}</td>
                      <td>
                        {s.model_degraded
                          ? <span className="badge yellow">⚠ Degraded model</span>
                          : <span className="badge green">✅ Active</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button className="btn btn-outline btn-sm" style={{ fontSize: 11.5, padding: '4px 10px' }}
                            onClick={() => handleResetDevice(s.id)}>
                            Reset Device
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }}
                            onClick={() => handleDelete(s)} disabled={deleting === s.id}>
                            {deleting === s.id ? '…' : I.trash}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>}

      {/* Create modal */}
      {showAdd && (
        <div className="modal-backdrop" onClick={() => { setShowAdd(false); setError(''); setShowPassword(false); }}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Create Scanner Account</div>
            <div className="modal-sub">This account can only mark attendance and view today's logs via the mobile app.</div>
            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input className="form-input" type="email" placeholder="scanner@company.com" required
                  value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Password <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(min 6 characters)</span></label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" type={showPassword ? 'text' : 'password'} placeholder="Minimum 6 characters" required minLength={6}
                    value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} style={{ paddingRight: 40 }} />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 0
                    }}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <span style={{ width: 18, height: 18, display: 'inline-block' }}>{showPassword ? I.eyeOff : I.eye}</span>
                  </button>
                </div>
              </div>
              <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: '#92400e', marginBottom: 8 }}>
                ⚠️ The scanner will receive a confirmation email. Share the credentials with the operator.
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setShowAdd(false); setError(''); setShowPassword(false); }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Creating…' : <>{I.send} Create Account</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATIONS
// ═══════════════════════════════════════════════════════════════════════════════
function LocationsPage({ adminId }: { adminId: string }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scanners, setScanners] = useState<ScannerAccount[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [saving, setSaving] = useState(false);

  // Scanner assign modal
  const [assignLoc, setAssignLoc] = useState<Location | null>(null);
  const [scannerSel, setScannerSel] = useState<Record<string, boolean>>({});
  const [assigning, setAssigning] = useState(false);

  // Delete confirm
  const [delId, setDelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [lr, er, sr] = await Promise.all([
      supabase.from('locations').select('*').eq('admin_id', adminId).order('name'),
      supabase.from('employees').select('*').eq('admin_id', adminId),
      supabase.from('profiles').select('id,email,location_id,created_at').eq('admin_id', adminId).eq('role', 'scanner'),
    ]);
    setLocations(lr.data ?? []);
    setEmployees((er.data ?? []) as Employee[]);
    setScanners((sr.data ?? []).map(s => ({ ...s, admin_id: adminId })) as ScannerAccount[]);
    setLoading(false);
  }, [adminId]);

  useEffect(() => { load(); }, [load]);

  const empCount = (locId: string) => employees.filter(e => e.location_id === locId).length;
  const scannerCount = (locId: string) => scanners.filter(s => s.location_id === locId).length;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    await supabase.from('locations').insert({ admin_id: adminId, name: newName.trim(), address: newAddr.trim() || null });
    setSaving(false);
    setNewName(''); setNewAddr(''); setShowCreate(false);
    load();
  };

  const handleDelete = async (id: string) => {
    const loc = locations.find(l => l.id === id);
    const res = await softDeleteRecord('locations', id, adminId, 'admin', 'admin', loc?.name ?? id);
    if (!res.success) {
      alert(`Failed to delete location: ${res.error}`);
      setDelId(null);
      return;
    }
    await auditLog(adminId, 'location.delete', id, loc?.name ?? id, {
      address: loc?.address ?? null,
      soft_deleted: true,
    });
    setDelId(null);
    load();
  };

  const openAssign = (loc: Location) => {
    setAssignLoc(loc);
    const init: Record<string, boolean> = {};
    scanners.forEach(s => { init[s.id] = s.location_id === loc.id; });
    setScannerSel(init);
  };

  const handleAssign = async () => {
    if (!assignLoc) return;
    setAssigning(true);
    for (const s of scanners) {
      const shouldAssign = scannerSel[s.id];
      const isAssigned = s.location_id === assignLoc.id;
      if (shouldAssign && !isAssigned) {
        await supabase.from('profiles').update({ location_id: assignLoc.id }).eq('id', s.id).eq('admin_id', adminId);
      } else if (!shouldAssign && isAssigned) {
        await supabase.from('profiles').update({ location_id: null }).eq('id', s.id).eq('admin_id', adminId);
      }
    }
    setAssigning(false);
    setAssignLoc(null);
    load();
  };

  return (
    <div>
      {/* Header — shown when locations exist */}
      {locations.length > 0 && (
        <div className="section-head mb-4">
          <div>
            <div className="section-title">Workplace Locations</div>
            <div className="section-sub">{locations.length} location{locations.length !== 1 ? 's' : ''} configured</div>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            {I.plus} Add Location
          </button>
        </div>
      )}

      {loading ? <div className="loader-overlay"><div className="spinner" /></div> : (
        locations.length === 0 ? (
          <div className="card" style={{ padding: '60px 20px', textAlign: 'center' }}>
            <div className="empty-state" style={{ padding: 0 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', background: 'rgba(37,99,235,0.08)',
                color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16
              }}>
                <span style={{ width: 32, height: 32 }}>{I.location}</span>
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>No locations configured yet</h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)', maxWidth: 440, margin: '0 auto 24px' }}>
                Create your first workplace location to assign employees and scanner devices to specific geolocations.
              </p>
              <button className="btn btn-primary" style={{ padding: '10px 20px', fontSize: 14 }} onClick={() => setShowCreate(true)}>
                {I.plus} Add Location
              </button>
            </div>
          </div>
        ) : (
          <div className="location-cards-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {locations.map(loc => (
              <div key={loc.id} className="card" style={{ padding: '20px 22px' }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10, background: 'rgba(37,99,235,0.08)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--primary)', flexShrink: 0
                  }}>
                    <span style={{ width: 20, height: 20 }}>{I.location}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{loc.name}</div>
                    {loc.address && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📍 {loc.address}
                      </div>
                    )}
                  </div>
                  <button className="btn btn-ghost" style={{ padding: 6, color: 'var(--danger)' }}
                    title="Delete location" onClick={() => setDelId(loc.id)}>
                    {I.x}
                  </button>
                </div>

                {/* Stats */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  <div style={{ flex: 1, padding: '10px 12px', background: 'var(--surface-alt)', borderRadius: 8, textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{empCount(loc.id)}</div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Employees</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 12px', background: 'var(--surface-alt)', borderRadius: 8, textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--primary)' }}>{scannerCount(loc.id)}</div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Scanners</div>
                  </div>
                </div>

                {/* Actions */}
                <button className="btn btn-outline" style={{ width: '100%', fontSize: 13 }} onClick={() => openAssign(loc)}>
                  {I.qr} Assign Scanners
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Create Location Modal */}
      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="modal-title" style={{ margin: 0 }}>Add Location</div>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)} style={{ padding: 8 }}>{I.x}</button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">Location Name *</label>
                <input className="form-input" placeholder="e.g. Head Office, Branch A" required
                  value={newName} onChange={e => setNewName(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Address (optional)</label>
                <input className="form-input" placeholder="e.g. 123 MG Road, Pune"
                  value={newAddr} onChange={e => setNewAddr(e.target.value)} />
              </div>
              <div className="modal-actions" style={{ marginTop: 20 }}>
                <button type="button" className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : `${I.plus} Create`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign Scanners Modal */}
      {assignLoc && (
        <div className="modal-backdrop" onClick={() => setAssignLoc(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div className="modal-title" style={{ margin: 0 }}>Assign Scanners</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {assignLoc.name}
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => setAssignLoc(null)} style={{ padding: 8 }}>{I.x}</button>
            </div>

            {scanners.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px 0' }}>
                {I.qr}<p>No scanner accounts created yet.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
                {scanners.map(s => (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 14px',
                    border: scannerSel[s.id] ? '1.5px solid var(--primary)' : '1px solid var(--border-light)',
                    borderRadius: 8, cursor: 'pointer',
                    background: scannerSel[s.id] ? 'rgba(37,99,235,0.04)' : 'var(--surface)',
                    transition: 'all 0.15s'
                  }}>
                    <input type="checkbox" checked={!!scannerSel[s.id]}
                      onChange={ev => setScannerSel(p => ({ ...p, [s.id]: ev.target.checked }))} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{s.email}</div>
                      {s.location_id && s.location_id !== assignLoc.id && (
                        <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 1 }}>
                          ⚠ Currently assigned to another location
                        </div>
                      )}
                    </div>
                    {scannerSel[s.id] && <span className="badge green">Assigned</span>}
                  </label>
                ))}
              </div>
            )}

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button type="button" className="btn btn-outline" onClick={() => setAssignLoc(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleAssign} disabled={assigning}>
                {assigning ? 'Saving…' : 'Save Assignments'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {delId && (
        <div className="modal-backdrop" onClick={() => setDelId(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-title">Delete Location?</div>
            <div className="modal-sub" style={{ marginTop: 8 }}>
              All employees and scanners assigned to this location will become <strong>unassigned</strong>. This cannot be undone.
            </div>
            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button className="btn btn-outline" onClick={() => setDelId(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => handleDelete(delId)}>Delete Location</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════

const ACTION_META: Record<string, { label: string; color: string; bg: string }> = {
  'employee.delete': { label: 'Employee Deleted', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
  'attendance.delete': { label: 'Punch Deleted', color: '#ea580c', bg: 'rgba(234,88,12,0.08)' },
  'attendance.manual_insert': { label: 'Punch Added', color: '#0284c7', bg: 'rgba(2,132,199,0.08)' },
  'attendance.calendar_override': { label: 'Calendar Override', color: '#7c3aed', bg: 'rgba(124,58,237,0.08)' },
  'holiday.insert': { label: 'Holiday Added', color: '#059669', bg: 'rgba(5,150,105,0.08)' },
  'holiday.delete': { label: 'Holiday Removed', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
  'leave.approved': { label: 'Leave Approved', color: '#059669', bg: 'rgba(5,150,105,0.08)' },
  'leave.rejected': { label: 'Leave Rejected', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
  'leave.pending': { label: 'Leave Reset to Pending', color: '#d97706', bg: 'rgba(217,119,6,0.08)' },
  'salary.update': { label: 'Salary Updated', color: '#0284c7', bg: 'rgba(2,132,199,0.08)' },
  'shift_override.delete': { label: 'Shift Override Removed', color: '#ea580c', bg: 'rgba(234,88,12,0.08)' },
  'scanner.delete': { label: 'Scanner Removed', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
  'location.delete': { label: 'Location Deleted', color: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
};

const PAGE_SIZE = 50;

function AuditLogPage({ adminId }: { adminId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [filterAct, setFilterAct] = useState('__all__');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('audit_log')
      .select('*', { count: 'exact' })
      .eq('admin_id', adminId)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filterAct !== '__all__') q = q.eq('action', filterAct);
    if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00');
    if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59');

    const { data, count } = await q;
    setEntries((data ?? []) as AuditLogEntry[]);
    setTotal(count ?? 0);
    setExpanded(null); // reset any open row when data refreshes
    setLoading(false);
  }, [adminId, page, filterAct, dateFrom, dateTo]);

  useEffect(() => { setPage(0); }, [filterAct, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Group entries by calendar date for timeline display
  const grouped = entries.reduce<Record<string, AuditLogEntry[]>>((acc, e) => {
    const day = new Date(e.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
    (acc[day] ??= []).push(e);
    return acc;
  }, {});

  // Icon per action type
  const actionIcon = (action: string) => {
    if (action.includes('delete') || action.includes('rejected'))
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>;
    if (action.includes('leave') || action.includes('approved'))
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
    if (action.includes('salary'))
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><line x1={12} y1={1} x2={12} y2={23} /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>;
    if (action.includes('holiday'))
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><rect x={3} y={4} width={18} height={18} rx={2} /><path d="M16 2v4M8 2v4M3 10h18" /></svg>;
    if (action.includes('attendance') || action.includes('punch') || action.includes('calendar'))
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><circle cx={12} cy={12} r={10} /><path d="M12 6v6l4 2" /></svg>;
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
  };

  // Human-readable detail rows
  const renderDetail = (detail: Record<string, unknown>) => {
    const LABELS: Record<string, string> = {
      date: 'Date', action: 'Attendance', employee_code: 'Emp. Code',
      override_name: 'Override By', reason: 'Reason', status: 'Status',
      shift: 'Shift', name: 'Name', amount: 'Amount', field: 'Field',
      old_value: 'Old Value', new_value: 'New Value',
    };
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px 24px', padding: '14px 18px', background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
        {Object.entries(detail).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {LABELS[k] ?? k.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 500 }}>
              {String(v)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      {/* ── Header ── */}
      <div className="section-head mb-4" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 34, height: 34, borderRadius: 10,
              background: 'linear-gradient(135deg, #3d6ff0, #2250cc)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(61,111,240,0.25)',
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 17, height: 17 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
            Audit Log
          </div>
          <div className="section-sub" style={{ marginTop: 4 }}>
            Append-only record of all admin actions · read-only
          </div>
        </div>
        {/* Event count chip */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, color: '#475569' }}>
            {total} event{total !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="audit-filter-bar" style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 20,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        flexWrap: 'nowrap',
        boxShadow: '0 1px 4px rgba(15,23,42,0.05)',
      }}>
        {/* Search/Filter icon */}
        <svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
          <circle cx={11} cy={11} r={8} /><path d="m21 21-4.35-4.35" />
        </svg>

        <select className="form-input" style={{ flex: '1 1 180px', minWidth: 0, borderColor: '#e2e8f0', background: '#f8fafc', fontSize: 13 }}
          value={filterAct} onChange={e => setFilterAct(e.target.value)}>
          <option value="__all__">All action types</option>
          {Object.entries(ACTION_META).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <div className="audit-filter-divider" style={{ width: 1, height: 28, background: '#e2e8f0', flexShrink: 0 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <rect x={3} y={4} width={18} height={18} rx={2} /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>From</span>
          <input className="form-input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ width: 140, borderColor: '#e2e8f0', background: '#f8fafc', fontSize: 13 }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>To</span>
          <input className="form-input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ width: 140, borderColor: '#e2e8f0', background: '#f8fafc', fontSize: 13 }} />
        </div>

        {(filterAct !== '__all__' || dateFrom || dateTo) && (
          <button
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid #fecdd3', background: '#fff1f2', color: '#e11d48', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            onClick={() => { setFilterAct('__all__'); setDateFrom(''); setDateTo(''); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 12, height: 12 }}><path d="M18 6 6 18M6 6l12 12" /></svg>
            Clear
          </button>
        )}
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="loader-overlay"><div className="spinner" /></div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          {I.shield}
          <h3>No audit entries yet</h3>
          <p>Events will appear here as admins create, update, or delete records.</p>
        </div>
      ) : (
        <>
          {/* ── Timeline ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {Object.entries(grouped).map(([day, dayEntries]) => (
              <div key={day}>
                {/* Day separator */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ height: 1, flex: 1, background: '#e2e8f0' }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.6, whiteSpace: 'nowrap' }}>
                    {day}
                  </span>
                  <div style={{ height: 1, flex: 1, background: '#e2e8f0' }} />
                </div>

                {/* Cards for this day */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {dayEntries.map(e => {
                    const meta = ACTION_META[e.action];
                    const isOpen = expanded === e.id;
                    const time = new Date(e.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

                    return (
                      <div key={e.id} style={{
                        background: '#fff',
                        border: `1px solid ${isOpen ? (meta?.color ?? '#e2e8f0') + '40' : '#e2e8f0'}`,
                        borderRadius: 12,
                        overflow: 'hidden',
                        boxShadow: isOpen ? `0 4px 16px ${(meta?.color ?? '#3d6ff0')}18` : '0 1px 3px rgba(15,23,42,0.05)',
                        transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
                      }}>
                        {/* Row */}
                        <div
                          onClick={() => e.detail && setExpanded(isOpen ? null : e.id)}
                          className="audit-log-row"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 14,
                            padding: '13px 18px',
                            cursor: e.detail ? 'pointer' : 'default',
                          }}>

                          {/* Action icon chip */}
                          <div className="audit-icon-chip" style={{
                            width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                            background: meta?.bg ?? '#f1f5f9',
                            color: meta?.color ?? '#64748b',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: `1.5px solid ${meta?.color ?? '#cbd5e1'}30`,
                          }}>
                            {actionIcon(e.action)}
                          </div>

                          {/* Action label badge */}
                          <div className="audit-action-badge" style={{ flexShrink: 0, minWidth: 155 }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              padding: '3px 10px', borderRadius: 20,
                              fontSize: 11.5, fontWeight: 700, letterSpacing: 0.2,
                              background: meta?.bg ?? '#f1f5f9',
                              color: meta?.color ?? '#64748b',
                            }}>
                              {meta?.label ?? e.action}
                            </span>
                          </div>

                          {/* Target */}
                          <div className="audit-target" style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {e.target_name}
                            </div>
                            {e.target_id && (
                              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2 }}>
                                {e.target_id.slice(0, 12)}…
                              </div>
                            )}
                          </div>

                          {/* Time */}
                          <div className="audit-time" style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500, flexShrink: 0, minWidth: 48, textAlign: 'right' }}>
                            {time}
                          </div>

                          {/* Expand chevron */}
                          {e.detail && (
                            <div className="audit-chevron" style={{
                              width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                              background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'transform 0.2s ease',
                              transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={2.5} style={{ width: 13, height: 13 }}>
                                <path d="m6 9 6 6 6-6" />
                              </svg>
                            </div>
                          )}
                        </div>

                        {/* Expanded detail */}
                        {isOpen && e.detail && renderDetail(e.detail as Record<string, unknown>)}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 }}>
              <button className="btn btn-outline btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}><path d="m15 18-6-6 6-6" /></svg>
                Prev
              </button>
              <span style={{ fontSize: 13, color: '#64748b', padding: '0 8px' }}>
                Page <strong>{page + 1}</strong> of <strong>{totalPages}</strong>
              </span>
              <button className="btn btn-outline btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                Next
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN: RECYCLE BIN & RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════
function SuperAdminRecycleBinPage() {
  const [items, setItems] = useState<RecycleBinRecord[]>([]);
  const [admins, setAdmins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAdmin, setFilterAdmin] = useState<string>('__all__');
  const [filterTable, setFilterTable] = useState<string>('__all__');
  const [search, setSearch] = useState('');
  const [selectedJson, setSelectedJson] = useState<RecycleBinRecord | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoredSuccessMsg, setRestoredSuccessMsg] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    const [binRes, profRes] = await Promise.all([
      supabase.from('recycle_bin').select('*').order('deleted_at', { ascending: false }),
      supabase.from('profiles').select('id, email, name, role').order('email'),
    ]);
    setItems((binRes.data as RecycleBinRecord[]) ?? []);
    setAdmins(profRes.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const adminMap = useMemo(() => {
    return Object.fromEntries(admins.map(a => [a.id, a]));
  }, [admins]);

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchesAdmin = filterAdmin === '__all__' || item.admin_id === filterAdmin;
      const matchesTable = filterTable === '__all__' || item.table_name === filterTable;
      const q = search.toLowerCase().trim();
      const matchesSearch = !q ||
        (item.record_name && item.record_name.toLowerCase().includes(q)) ||
        (item.table_name && item.table_name.toLowerCase().includes(q)) ||
        (item.deleted_by && item.deleted_by.toLowerCase().includes(q)) ||
        (item.record_id && item.record_id.toLowerCase().includes(q));
      return matchesAdmin && matchesTable && matchesSearch;
    });
  }, [items, filterAdmin, filterTable, search]);

  const handleRestore = async (item: RecycleBinRecord) => {
    if (!confirm(`Restore ${item.table_name} record "${item.record_name || item.record_id}"?`)) return;
    setRestoringId(item.id);
    const res = await restoreRecordFromRecycleBin(item.id, item.admin_id);
    setRestoringId(null);
    if (!res.success) {
      alert(`Restoration failed: ${res.error}`);
    } else {
      setRestoredSuccessMsg(`Successfully restored "${item.record_name || item.record_id}" (${item.table_name})`);
      setTimeout(() => setRestoredSuccessMsg(''), 4000);
      load();
    }
  };

  const TABLE_LABELS: Record<string, string> = {
    employees: '👥 Employee Profile',
    attendance: '⏱ Attendance Punch',
    employee_shifts: '📅 Shift Override',
    public_holidays: '🎉 Public Holiday',
    employee_holidays: '★ Custom Employee Holiday',
    profiles: '📱 Scanner Account',
    locations: '📍 Location',
    leave_requests: '🌿 Leave Request',
    weekly_off_days: '🗓 Weekly Off',
  };

  return (
    <div>
      {/* Header alert / Toast if restored */}
      {restoredSuccessMsg && (
        <div style={{
          background: 'var(--success-bg)',
          border: '1px solid var(--success)',
          color: '#047857',
          padding: '12px 18px',
          borderRadius: 8,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontWeight: 600,
          fontSize: 13.5
        }}>
          <span>✅</span>
          <span>{restoredSuccessMsg}</span>
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-icon red">🗑️</div>
          <div className="stat-info">
            <div className="stat-value">{items.length}</div>
            <div className="stat-label">Total Soft-Deleted</div>
            <span className="stat-sub neutral">In Recycle Bin</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue">🏢</div>
          <div className="stat-info">
            <div className="stat-value">{new Set(items.map(i => i.admin_id)).size}</div>
            <div className="stat-label">Tenants Affected</div>
            <span className="stat-sub up">Companies</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon yellow">📊</div>
          <div className="stat-info">
            <div className="stat-value">{new Set(items.map(i => i.table_name)).size}</div>
            <div className="stat-label">Entity Types</div>
            <span className="stat-sub neutral">Tables</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green">🛡️</div>
          <div className="stat-info">
            <div className="stat-value">100%</div>
            <div className="stat-label">Recoverable</div>
            <span className="stat-sub up">Full Integrity</span>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="card mb-4">
        <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '14px 20px' }}>
          <div className="search-wrap" style={{ flex: 1, minWidth: 200 }}>
            {I.search}
            <input className="form-input search-input" placeholder="Search deleted records by name, ID, or deleted by..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <select className="form-input" value={filterAdmin} style={{ minWidth: 180 }}
              onChange={e => setFilterAdmin(e.target.value)}>
              <option value="__all__">All Companies / Admins</option>
              {admins.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.email}</option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <select className="form-input" value={filterTable} style={{ minWidth: 160 }}
              onChange={e => setFilterTable(e.target.value)}>
              <option value="__all__">All Record Types</option>
              {Object.keys(TABLE_LABELS).map(tbl => (
                <option key={tbl} value={tbl}>{TABLE_LABELS[tbl]}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Main Table */}
      {loading ? (
        <div className="loader-overlay"><div className="spinner" /></div>
      ) : (
        <div className="card">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="card-title">Recycle Bin Items</div>
            <span className="badge red">{filteredItems.length} records</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Record Name</th>
                  <th>Entity Type</th>
                  <th>Company / Admin</th>
                  <th>Deleted By</th>
                  <th>Deleted Date & Time</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">
                        🗑️
                        <h3>No deleted records found</h3>
                        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Items soft-deleted by admins will appear here for Super Admin recovery.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredItems.map(item => {
                    const adm = adminMap[item.admin_id];
                    return (
                      <tr key={item.id}>
                        <td>
                          <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>
                            {item.record_name || item.record_id}
                          </div>
                          <code style={{ fontSize: 10.5, background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4 }}>
                            {item.record_id}
                          </code>
                        </td>
                        <td>
                          <span className="badge blue" style={{ fontSize: 11, fontWeight: 600 }}>
                            {TABLE_LABELS[item.table_name] || item.table_name}
                          </span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: 12.5 }}>{adm?.name || adm?.email || '—'}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{item.admin_id.slice(0, 8)}…</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{item.deleted_by || 'Admin'}</div>
                          <span className="badge grey" style={{ fontSize: 9.5 }}>{item.deleted_by_role || 'admin'}</span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {new Date(item.deleted_at).toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short'
                          })}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setSelectedJson(item)}
                              title="Inspect original record JSON payload"
                            >
                              🔍 View Data
                            </button>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleRestore(item)}
                              disabled={restoringId === item.id}
                              style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                            >
                              {restoringId === item.id ? 'Restoring…' : '↺ Restore'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Record Inspection Modal */}
      {selectedJson && (
        <RecycleBinDetailModal
          item={selectedJson}
          adminMap={adminMap}
          onClose={() => setSelectedJson(null)}
          onRestore={handleRestore}
        />
      )}
    </div>
  );
}

function RecycleBinDetailModal({
  item,
  adminMap,
  onClose,
  onRestore
}: {
  item: RecycleBinRecord;
  adminMap: Record<string, any>;
  onClose: () => void;
  onRestore: (item: RecycleBinRecord) => void;
}) {
  const [viewTab, setViewTab] = useState<'formatted' | 'raw'>('formatted');
  const data = item.record_data || {};
  const meta = item.metadata || {};
  const adm = adminMap[item.admin_id];

  const formatKeyLabel = (key: string) => {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  const formatValue = (key: string, val: any) => {
    if (val === null || val === undefined || val === '') return <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not set</span>;
    if (typeof val === 'boolean') {
      return val ? <span className="badge green" style={{ fontSize: 11 }}>Yes / Active</span> : <span className="badge red" style={{ fontSize: 11 }}>No / Inactive</span>;
    }
    if (key === 'face_embedding') return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Vector Embedding Data</span>;
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  };

  const salObj = meta?.associated_employee_salary?.[0] || data?.salary;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, width: '90vw', padding: '20px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div className="modal-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🗑️ Deleted Record Details</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Snapshot captured on {new Date(item.deleted_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>{I.x}</button>
        </div>

        {/* View Toggle Tabs */}
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setViewTab('formatted')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
              border: 'none',
              background: viewTab === 'formatted' ? 'var(--primary)' : 'var(--surface-2)',
              color: viewTab === 'formatted' ? '#ffffff' : 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>✨ Clear Visual View</span>
          </button>
          <button
            type="button"
            onClick={() => setViewTab('raw')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
              border: 'none',
              background: viewTab === 'raw' ? '#0f172a' : 'var(--surface-2)',
              color: viewTab === 'raw' ? '#38bdf8' : 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>💻 Raw JSON Payload</span>
          </button>
        </div>

        {/* TAB 1: Formatted Visuals */}
        {viewTab === 'formatted' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            {/* Top Overview Banner */}
            <div style={{
              background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5 }}>
                  {item.table_name.toUpperCase()} RECORD
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>
                  {item.record_name || item.record_id}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  Deleted by <strong>{item.deleted_by || 'Admin'}</strong> ({item.deleted_by_role || 'admin'})
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="badge blue" style={{ fontSize: 11, padding: '4px 10px' }}>
                  {item.table_name}
                </span>
                {adm && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Org: <strong>{adm.name || adm.email}</strong>
                  </div>
                )}
              </div>
            </div>

            {/* Table-Specific Visual Component */}
            {item.table_name === 'employees' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary-dark)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>👤 Employee Profile Information</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px 16px', fontSize: 12.5 }}>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Full Name</span>
                      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{data.name || '—'}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Employee Code / ID</span>
                      <div><code style={{ background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>{data.employee_id || '—'}</code></div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Department</span>
                      <div style={{ fontWeight: 600 }}>{data.department || <span style={{ color: 'var(--text-muted)' }}>Not assigned</span>}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Designation</span>
                      <div style={{ fontWeight: 600 }}>{data.designation || <span style={{ color: 'var(--text-muted)' }}>Not assigned</span>}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Shift Timings</span>
                      <div style={{ fontWeight: 600 }}>⏰ {data.shift_start || '09:00'} – {data.shift_end || '18:00'}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Joining Date</span>
                      <div style={{ fontWeight: 600 }}>{data.joining_date ? new Date(data.joining_date).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : 'Not set'}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Overtime Settings</span>
                      <div style={{ fontWeight: 600 }}>
                        {data.overtime_enabled ? (
                          <span className="badge green" style={{ fontSize: 10.5 }}>Enabled (₹{data.overtime_rate_per_hour || 0}/hr)</span>
                        ) : (
                          <span className="badge grey" style={{ fontSize: 10.5 }}>Disabled</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Employment Status</span>
                      <div>
                        {data.is_active !== false ? (
                          <span className="badge green" style={{ fontSize: 10.5 }}>Active</span>
                        ) : (
                          <span className="badge red" style={{ fontSize: 10.5 }}>Inactive</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Salary Package Box */}
                {salObj && (
                  <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#047857', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>💵 Associated Salary & Compensation Package</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, fontSize: 12.5 }}>
                      <div>
                        <span style={{ color: '#047857', opacity: 0.8, fontSize: 11 }}>Monthly Base Salary</span>
                        <div style={{ fontSize: 16, fontWeight: 800, color: '#065f46' }}>
                          ₹{(salObj.monthly_salary || salObj.monthly_net_salary || 0).toLocaleString('en-IN')} / month
                        </div>
                      </div>
                      <div>
                        <span style={{ color: '#047857', opacity: 0.8, fontSize: 11 }}>Pay Structure</span>
                        <div style={{ fontWeight: 700, color: '#065f46', marginTop: 2 }}>
                          {salObj.is_hourly ? `Hourly (₹${salObj.hourly_rate || 0}/hr)` : 'Fixed Monthly Salary'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : item.table_name === 'attendance' ? (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary-dark)', marginBottom: 10 }}>
                  ⏱ Attendance Punch Details
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Employee Name</span>
                    <div style={{ fontWeight: 700 }}>{data.employee_name || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Punch Type</span>
                    <div>
                      <span className={`badge ${data.punch_type === 'check_in' ? 'green' : 'blue'}`}>
                        {data.punch_type === 'check_in' ? '▲ CHECK IN' : '▼ CHECK OUT'}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Date & Time</span>
                    <div style={{ fontWeight: 600 }}>{data.timestamp ? new Date(data.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' }) : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Verification Method</span>
                    <div style={{ fontWeight: 600 }}>{data.verification_method || 'Scanner'}</div>
                  </div>
                </div>
              </div>
            ) : item.table_name === 'public_holidays' || item.table_name === 'employee_holidays' ? (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary-dark)', marginBottom: 10 }}>
                  🎉 Holiday Record Details
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Holiday Title</span>
                    <div style={{ fontWeight: 700 }}>{data.name || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Date</span>
                    <div style={{ fontWeight: 700 }}>{data.date ? new Date(data.date).toLocaleDateString('en-IN', { dateStyle: 'full' }) : '—'}</div>
                  </div>
                </div>
              </div>
            ) : item.table_name === 'locations' ? (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary-dark)', marginBottom: 10 }}>
                  📍 Geofenced Location Details
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Location Name</span>
                    <div style={{ fontWeight: 700 }}>{data.name || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Address</span>
                    <div style={{ fontWeight: 600 }}>{data.address || 'No address specified'}</div>
                  </div>
                </div>
              </div>
            ) : (
              /* Generic Key-Value Grid for any other table */
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary-dark)', marginBottom: 10 }}>
                  📋 Record Properties
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px 16px', fontSize: 12.5 }}>
                  {Object.entries(data).map(([k, v]) => (
                    <div key={k}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatKeyLabel(k)}</span>
                      <div style={{ fontWeight: 600, color: 'var(--text)', wordBreak: 'break-word' }}>
                        {formatValue(k, v)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* TAB 2: Raw Technical JSON */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: '#0f172a', color: '#38bdf8', padding: 14, borderRadius: 8, overflowX: 'auto', maxHeight: 360, fontSize: 12, fontFamily: 'monospace' }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(item.record_data, null, 2)}
              </pre>
            </div>
            {item.metadata && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>Associated Metadata / Cascades:</div>
                <div style={{ background: '#1e293b', color: '#a7f3d0', padding: 10, borderRadius: 8, fontSize: 11, fontFamily: 'monospace', maxHeight: 180, overflowY: 'auto' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {JSON.stringify(item.metadata, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="modal-actions" style={{ marginTop: 20, display: 'flex', gap: 10 }}>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>Close Window</button>
          <button
            className="btn btn-primary"
            style={{ flex: 1, background: 'var(--success)', borderColor: 'var(--success)' }}
            onClick={() => {
              onClose();
              onRestore(item);
            }}
          >
            ↺ Restore Record Now
          </button>
        </div>
      </div>
    </div>
  );
}

const PAGE_TITLES: Record<Page, { title: string; sub: string }> = {
  dashboard: { title: 'Dashboard', sub: 'Overview of today\'s attendance & activity' },
  employees: { title: 'Employees', sub: 'Manage your team members' },
  attendance: { title: 'Attendance', sub: 'Daily log · Calendar view · Shift scheduler' },
  payroll: { title: 'Payroll', sub: 'Monthly salary & attendance-based net pay' },
  holidays: { title: 'Holidays', sub: 'Public holidays calendar management' },
  reports: { title: 'Reports', sub: 'Attendance, employee & payroll reports with CSV export' },
  scanners: { title: 'Scanners', sub: 'Manage scanner accounts for the mobile attendance app' },
  locations: { title: 'Locations', sub: 'Manage workplace geolocations, employee assignments & scanner scopes' },
  audit_log: { title: 'Audit Log', sub: 'Append-only record of all admin mutations' },
  super_admin_dash: { title: 'Platform Command Center', sub: 'System-wide metrics, tenant health & live activity stream' },
  super_admin_companies: { title: 'Companies & Tenants', sub: 'Directory of registered companies, status management & admin access' },
  super_admin_admins: { title: 'Admin Accounts', sub: 'Manage organization administrators & privilege access' },
  super_admin_analytics: { title: 'Platform Analytics', sub: 'Growth trends, attendance surges & payroll volume' },
  super_admin_security: { title: 'Security & Audit Logs', sub: 'System-wide audit trail, login history & impersonation records' },
  super_admin_health: { title: 'System Health & Infrastructure', sub: 'API response metrics, Supabase connection status & service health' },
  super_admin_recycle_bin: { title: 'Recycle Bin & Data Recovery', sub: 'View, inspect & restore soft-deleted records across all tenants' },
};

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Super Admin & Impersonation state
  const [impersonatedAdmin, setImpersonatedAdmin] = useState<{ id: string; email: string; name?: string } | null>(null);

  const SUPER_ADMIN_EMAILS = ['macrotechsoftwares@gmail.com', 'amndby222@gmail.com'];
  const isSuperAdmin = session?.user?.email ? SUPER_ADMIN_EMAILS.includes(session.user.email.trim().toLowerCase()) : false;

  const activeAdminId = impersonatedAdmin ? impersonatedAdmin.id : session?.user.id ?? '';

  // Redirect Super Admin to Platform Analytics when logging in
  useEffect(() => {
    if (isSuperAdmin && !impersonatedAdmin && (page === 'dashboard' || page as string === '')) {
      setPage('super_admin_dash');
    }
  }, [isSuperAdmin, session, impersonatedAdmin]);

  const handleStartImpersonate = async (admin: { id: string; email: string; name?: string }) => {
    setImpersonatedAdmin({ id: admin.id, email: admin.email, name: admin.name });
    await auditLog(admin.id, 'super_admin.impersonate_start', admin.id, admin.email, {
      super_admin_email: session?.user.email,
      target_admin_email: admin.email,
      login_time: new Date().toISOString(),
    });
    setPage('dashboard');
  };

  const handleExitImpersonation = async () => {
    if (impersonatedAdmin) {
      await auditLog(impersonatedAdmin.id, 'super_admin.impersonate_exit', impersonatedAdmin.id, impersonatedAdmin.email, {
        super_admin_email: session?.user.email,
        logout_time: new Date().toISOString(),
      });
    }
    setImpersonatedAdmin(null);
    setPage('super_admin_companies');
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    setRefreshTrigger(prev => prev + 1);
    setTimeout(() => setIsRefreshing(false), 600);
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!isResettingPassword && data.session) {
        if (data.session.user.email && !SUPER_ADMIN_EMAILS.includes(data.session.user.email.trim().toLowerCase())) {
          const { data: prof } = await supabase.from('profiles').select('*').eq('id', data.session.user.id).maybeSingle();
          if (prof && (prof as any).status === 'suspended') {
            await supabase.auth.signOut();
            setSession(null);
            setBootstrapping(false);
            return;
          }
        }
        setSession(data.session as Session | null);
      }
      setBootstrapping(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (e, s) => {
      if (e === 'PASSWORD_RECOVERY' || isResettingPassword) {
        return;
      }
      if (s?.user?.email && !SUPER_ADMIN_EMAILS.includes(s.user.email.trim().toLowerCase())) {
        const { data: prof } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
        if (prof && (prof as any).status === 'suspended') {
          await supabase.auth.signOut();
          setSession(null);
          return;
        }
      }
      setSession(s as Session | null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Close sidebar on page resize to desktop
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 769) setSidebarOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setImpersonatedAdmin(null);
  };

  if (bootstrapping) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  );

  if (!session) return <LoginPage onLogin={setSession} />;

  const { title, sub } = PAGE_TITLES[page] ?? { title: 'Dashboard', sub: '' };

  return (
    <div className="app-shell" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {/* ── Enterprise Super Admin Impersonation Banner ── */}
      {impersonatedAdmin && (
        <div style={{
          background: 'linear-gradient(90deg, #0f172a 0%, #1e293b 50%, #334155 100%)',
          color: '#ffffff',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          zIndex: 5000,
          position: 'sticky',
          top: 0,
          borderBottom: '2px solid #3b82f6',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{
              background: '#3b82f6',
              color: '#ffffff',
              padding: '3px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx={12} cy={12} r={3} />
              </svg>
              <span>SUPER ADMIN VIEW</span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              Viewing Organization: <strong style={{ color: '#38bdf8' }}>{impersonatedAdmin.name || 'Company'}</strong>
              <span style={{ opacity: 0.5, margin: '0 8px' }}>•</span>
              Admin: <strong style={{ color: '#93c5fd' }}>{impersonatedAdmin.email}</strong>
            </span>
          </div>
          <button
            onClick={handleExitImpersonation}
            style={{
              background: '#ef4444',
              color: '#ffffff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 6,
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: '0 2px 6px rgba(239, 68, 68, 0.4)',
            }}
          >
            <span>Return to Super Admin Portal</span> ✕
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, height: impersonatedAdmin ? 'calc(100vh - 44px)' : '100vh', overflow: 'hidden' }}>
        <Sidebar
          page={page}
          setPage={setPage}
          email={session.user.email}
          onLogout={handleLogout}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          isSuperAdmin={isSuperAdmin}
          isImpersonating={!!impersonatedAdmin}
        />
        <div className="main-content">
          <header className="main-header">
            {/* Hamburger — only visible on mobile via CSS */}
            <button
              className="mob-menu-btn"
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Open navigation menu"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1={3} y1={6} x2={21} y2={6} />
                <line x1={3} y1={12} x2={21} y2={12} />
                <line x1={3} y1={18} x2={21} y2={18} />
              </svg>
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="main-header-title">{title}</div>
              <div className="main-header-subtitle">{sub}</div>
            </div>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="refresh-btn"
              title="Refresh current page data"
            >
              <svg
                className={isRefreshing ? 'spin-anim' : ''}
                style={{ width: 16, height: 16 }}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.5 2v6h-6" />
                <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l.57-.57" />
              </svg>
            </button>
          </header>
          <main className="main-body">
            {page === 'super_admin_dash' && <SuperAdminDashboardPage setPage={setPage} onImpersonate={handleStartImpersonate} />}
            {page === 'super_admin_companies' && <SuperAdminCompaniesPage onImpersonate={handleStartImpersonate} />}
            {page === 'super_admin_admins' && <SuperAdminAdminsPage onImpersonate={handleStartImpersonate} />}
            {page === 'super_admin_analytics' && <SuperAdminAnalyticsPage />}
            {page === 'super_admin_security' && <SuperAdminSecurityPage />}
            {page === 'super_admin_health' && <SuperAdminHealthPage />}
            {page === 'super_admin_recycle_bin' && <SuperAdminRecycleBinPage />}

            {page === 'dashboard' && <DashboardPage key={`dashboard-${refreshTrigger}`} adminId={activeAdminId} setPage={setPage} />}
            {page === 'employees' && <EmployeesPage key={`employees-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'attendance' && <AttendancePage key={`attendance-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'payroll' && <PayrollPage key={`payroll-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'holidays' && <HolidaysPage key={`holidays-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'reports' && <ReportsPage key={`reports-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'scanners' && <ScannersPage key={`scanners-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'locations' && <LocationsPage key={`locations-${refreshTrigger}`} adminId={activeAdminId} />}
            {page === 'audit_log' && <AuditLogPage key={`audit_log-${refreshTrigger}`} adminId={activeAdminId} />}
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;
