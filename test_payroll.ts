// ============================================================
// StaffEase — Standalone Payroll Calculation Tests
// Run: npx tsx test_payroll.ts
// ============================================================

import assert from 'assert';

// ── Types ──
interface Employee {
  id: string; admin_id: string; name: string;
  employee_id: string; shift_start: string; shift_end: string;
  image_url?: string; created_at: string;
  pin_hash?: string; pin_salt?: string;
  location_id?: string | null;
}

interface EmployeeSalary {
  id: string; employee_id: string; monthly_salary: number;
  hourly_rate: number; is_hourly: boolean;
}

interface PublicHoliday { id: string; name: string; date: string; }

interface SalarySlip {
  emp: Employee;
  sal: EmployeeSalary | undefined;
  daysInMonth: number;
  workingDays: number;
  daysPresent: number;
  daysAbsent: number;
  leavesUsed: number;
  leavesAllotted: number;
  perDaySalary: number;
  grossPay: number;
  absentDeduction: number;
  leaveDeduction: number;
  overtimeHours: number;
  overtimePay: number;
  netPay: number;
  totalWorkedMinutes?: number;
}

interface PayrollInput {
  emp: Employee;
  salary: EmployeeSalary | undefined;
  leavesAllotted: number;
  presentDates: Set<string>;
  otHours: number;
  totalWorkedMinutes?: number;
  holidays: PublicHoliday[];
  empHolidays: string[];
  year: number;
  month: number;
}

// ── Helper functions copied from App.tsx ──
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function calculateSalarySlip(input: PayrollInput): SalarySlip {
  const { emp, salary, leavesAllotted, presentDates, otHours, holidays, empHolidays, year, month, totalWorkedMinutes = 0 } = input;

  const dim = new Date(year, month, 0).getDate();
  const holSet = new Set([...holidays.map(h => h.date), ...empHolidays]);
  let working = 0;
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() !== 0 && !holSet.has(ymd(dt))) working++;
  }

  const daysPresent = presentDates.size;
  const daysAbsent = Math.max(0, working - daysPresent);
  const leavesUsed = daysAbsent;
  const leaveExcess = Math.max(0, leavesUsed - leavesAllotted);

  const gross = salary?.monthly_salary ?? 0;
  const perDay = working > 0 ? gross / working : 0;
  const leaveDed = Math.round(perDay * leaveExcess);

  const hourlyRate = working > 0 ? (gross / working) / 8 : 0;
  const overtimePay = Math.round(otHours * hourlyRate);

  const netPay = Math.max(0, gross - leaveDed + overtimePay);

  return {
    emp,
    sal: salary,
    daysInMonth: dim,
    workingDays: working,
    daysPresent,
    daysAbsent,
    leavesUsed,
    leavesAllotted,
    perDaySalary: perDay,
    grossPay: gross,
    absentDeduction: leaveDed,
    leaveDeduction: leaveDed,
    overtimeHours: otHours,
    overtimePay,
    netPay,
    totalWorkedMinutes,
  };
}

// ── Test Runner ──
const mockEmployee: Employee = {
  id: 'emp-1',
  admin_id: 'admin-1',
  name: 'John Doe',
  employee_id: 'SE-001',
  shift_start: '09:00',
  shift_end: '18:00',
  created_at: new Date().toISOString(),
};

const mockSalary: EmployeeSalary = {
  id: 'sal-1',
  employee_id: 'emp-1',
  monthly_salary: 30000,
  hourly_rate: 0,
  is_hourly: false,
};

function runTests() {
  console.log('🚀 Running StaffEase Payroll Calculation Tests...\n');

  // Test Case 1: Full Attendance (No leaves, no overtime, no holidays in July 2026)
  // July 2026 has 31 days. There are 4 Sundays. Working days should be 27.
  {
    const presentDates = new Set<string>();
    // July 2026 sundays: 5, 12, 19, 26
    for (let d = 1; d <= 31; d++) {
      const dayOfWeek = new Date(2026, 6, d).getDay();
      if (dayOfWeek !== 0) {
        presentDates.add(`2026-07-${String(d).padStart(2, '0')}`);
      }
    }

    const res = calculateSalarySlip({
      emp: mockEmployee,
      salary: mockSalary,
      leavesAllotted: 0,
      presentDates,
      otHours: 0,
      holidays: [],
      empHolidays: [],
      year: 2026,
      month: 7,
    });

    assert.strictEqual(res.workingDays, 27, 'July 2026 should have 27 working days');
    assert.strictEqual(res.daysPresent, 27, 'Should be present for all 27 working days');
    assert.strictEqual(res.daysAbsent, 0, 'Should have 0 absent days');
    assert.strictEqual(res.netPay, 30000, 'Full attendance net pay should equal gross pay');
    console.log('✅ Test Case 1 Passed: Full Attendance');
  }

  // Test Case 2: Overtime Pay
  {
    const presentDates = new Set<string>();
    for (let d = 1; d <= 31; d++) {
      const dayOfWeek = new Date(2026, 6, d).getDay();
      if (dayOfWeek !== 0) {
        presentDates.add(`2026-07-${String(d).padStart(2, '0')}`);
      }
    }

    const res = calculateSalarySlip({
      emp: mockEmployee,
      salary: mockSalary,
      leavesAllotted: 0,
      presentDates,
      otHours: 10, // 10 overtime hours
      holidays: [],
      empHolidays: [],
      year: 2026,
      month: 7,
    });

    const expectedHourly = (30000 / 27) / 8;
    const expectedOTPay = Math.round(10 * expectedHourly);
    assert.strictEqual(res.overtimePay, expectedOTPay, 'Overtime compensation mismatch');
    assert.strictEqual(res.netPay, 30000 + expectedOTPay, 'Net pay must include overtime compensation');
    console.log('✅ Test Case 2 Passed: Overtime Pay Calculation');
  }

  // Test Case 3: Leave Deductions (Allotted Leaves Offset)
  {
    const presentDates = new Set<string>();
    // John is absent for 5 working days
    let absentCount = 0;
    for (let d = 1; d <= 31; d++) {
      const dayOfWeek = new Date(2026, 6, d).getDay();
      if (dayOfWeek !== 0) {
        if (absentCount < 5) {
          absentCount++;
        } else {
          presentDates.add(`2026-07-${String(d).padStart(2, '0')}`);
        }
      }
    }

    const res = calculateSalarySlip({
      emp: mockEmployee,
      salary: mockSalary,
      leavesAllotted: 2, // 2 days of paid leaves allotted
      presentDates,
      otHours: 0,
      holidays: [],
      empHolidays: [],
      year: 2026,
      month: 7,
    });

    assert.strictEqual(res.daysPresent, 22, 'Should be present 22 days');
    assert.strictEqual(res.daysAbsent, 5, 'Should be absent 5 days');
    // Excess absent days = 5 - 2 = 3 days.
    const perDay = 30000 / 27;
    const expectedDed = Math.round(perDay * 3);
    assert.strictEqual(res.leaveDeduction, expectedDed, 'Leave deduction mismatch');
    assert.strictEqual(res.netPay, 30000 - expectedDed, 'Net pay must subtract excess leave deduction');
    console.log('✅ Test Case 3 Passed: Leave Allotment Offset & Deductions');
  }

  // Test Case 4: Holidays (Public & Custom Employee Holiday Adjustments)
  {
    const presentDates = new Set<string>();
    for (let d = 1; d <= 31; d++) {
      const dayOfWeek = new Date(2026, 6, d).getDay();
      if (dayOfWeek !== 0) {
        presentDates.add(`2026-07-${String(d).padStart(2, '0')}`);
      }
    }

    // 1 public holiday on July 10th and 1 custom employee holiday on July 15th
    // Since John is present on all remaining days, working days should reduce from 27 to 25.
    presentDates.delete('2026-07-10');
    presentDates.delete('2026-07-15');

    const res = calculateSalarySlip({
      emp: mockEmployee,
      salary: mockSalary,
      leavesAllotted: 0,
      presentDates,
      otHours: 0,
      holidays: [{ id: 'h-1', name: 'National Day', date: '2026-07-10' }],
      empHolidays: ['2026-07-15'],
      year: 2026,
      month: 7,
    });

    assert.strictEqual(res.workingDays, 25, 'Holidays should reduce total monthly working days');
    assert.strictEqual(res.daysPresent, 25, 'John should be present for all 25 working days');
    assert.strictEqual(res.daysAbsent, 0, 'No absent days as holiday is not counted as working day');
    assert.strictEqual(res.netPay, 30000, 'Holiday hours should be paid');
    console.log('✅ Test Case 4 Passed: Holidays & Working Days Reduction');
  }

  console.log('\n🎉 All test cases passed successfully!');
}

runTests();
