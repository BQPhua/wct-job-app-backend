'use strict';

// Offboarding constants shared by the API, mailer and PDF generator.

const STATUSES = [
  'invited', 'clearance_in_progress', 'pending_acknowledgement',
  'pending_payroll', 'completed', 'cancelled',
];
const OPEN_STATUSES = STATUSES.filter((s) => s !== 'completed' && s !== 'cancelled');

const STATUS_LABELS = {
  invited: 'Invited',
  clearance_in_progress: 'Clearance in progress',
  pending_acknowledgement: 'Pending acknowledgement',
  pending_payroll: 'Pending payroll',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// Same 12 reasons, same order, as the WCT Exit Interview form (and the
// job-app's previous EXIT_REASONS_LEFT/RIGHT lists).
const EXIT_REASONS = [
  'Compensation (Salary / Benefits)', 'Conflict with colleague/superior',
  'Better Offer', 'Relocation',
  'Career Advancement', 'Retirement',
  'Lack of promotional opportunities', 'Health',
  'Lack of training', 'Return to Study',
  'Working Hours', 'Distance travelled to work',
];

// Days-left windows for the automatic clearance reminders: 7..4 days left
// sends the "7-day" reminder, 3..0 the "3-day" one (Qurratu's rule).
const REMINDER_WINDOWS = [
  { days_before: 7, min: 4, max: 7 },
  { days_before: 3, min: 0, max: 3 },
];

const TOTAL_SECTIONS = 6;
const REPORTING_UNIT_ID = 1;

module.exports = { STATUSES, OPEN_STATUSES, STATUS_LABELS, EXIT_REASONS, REMINDER_WINDOWS, TOTAL_SECTIONS, REPORTING_UNIT_ID };
