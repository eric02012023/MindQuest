-- ANNOTATED COPY FOR DEFENSE REVIEW
-- File: sql/schema.sql
-- Purpose: Primary database schema definition for the system tables, relationships, and constraints.

IF OBJECT_ID('dbo.branches', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.branches (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(120) NOT NULL UNIQUE,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE())
  );
END;

IF OBJECT_ID('dbo.subjects', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.subjects (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(160) NOT NULL UNIQUE,
    category NVARCHAR(120) NOT NULL DEFAULT 'Academic',
    image_path NVARCHAR(255) NULL,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE())
  );
END;

IF OBJECT_ID('dbo.submissions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.submissions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    submission_type NVARCHAR(20) NOT NULL CHECK (submission_type IN ('student','tutor')),
    branch_id INT NULL,
    password_hash NVARCHAR(255) NOT NULL,
    first_name NVARCHAR(100) NOT NULL,
    middle_name NVARCHAR(100) NOT NULL DEFAULT '',
    last_name NVARCHAR(100) NOT NULL,
    birth_date DATE NULL,
    age INT NULL,
    gender NVARCHAR(50) NOT NULL DEFAULT '',
    contact_number NVARCHAR(50) NOT NULL DEFAULT '',
    email NVARCHAR(150) NOT NULL DEFAULT '',
    facebook_account NVARCHAR(200) NOT NULL DEFAULT '',
    address NVARCHAR(MAX) NULL,
    year_level NVARCHAR(100) NOT NULL DEFAULT '',
    grade_level NVARCHAR(100) NOT NULL DEFAULT '',
    parent_guardian_name NVARCHAR(150) NOT NULL DEFAULT '',
    parent_contact_number NVARCHAR(60) NOT NULL DEFAULT '',
    parent_email NVARCHAR(150) NOT NULL DEFAULT '',
    parent_facebook NVARCHAR(200) NOT NULL DEFAULT '',
    image_path NVARCHAR(255) NULL,
    subjects_json NVARCHAR(MAX) NULL,
    support_json NVARCHAR(MAX) NULL,
    extra_json NVARCHAR(MAX) NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled')),
    archived BIT NOT NULL DEFAULT 0,
    read_at DATETIME2 NULL,
    archived_at DATETIME2 NULL,
    accepted_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_submissions_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id NVARCHAR(50) NOT NULL UNIQUE,
    role NVARCHAR(30) NOT NULL CHECK (role IN ('admin','admin_assistant','student','tutor')),
    branch_id INT NULL,
    assistant_scope_branch_id INT NULL,
    password_hash NVARCHAR(255) NOT NULL,
    first_name NVARCHAR(100) NOT NULL,
    middle_name NVARCHAR(100) NOT NULL DEFAULT '',
    last_name NVARCHAR(100) NOT NULL,
    birth_date DATE NULL,
    age INT NULL,
    gender NVARCHAR(50) NOT NULL DEFAULT '',
    contact_number NVARCHAR(50) NOT NULL DEFAULT '',
    email NVARCHAR(150) NOT NULL DEFAULT '',
    facebook_account NVARCHAR(200) NOT NULL DEFAULT '',
    address NVARCHAR(MAX) NULL,
    year_level NVARCHAR(100) NOT NULL DEFAULT '',
    grade_level NVARCHAR(100) NOT NULL DEFAULT '',
    parent_guardian_name NVARCHAR(150) NOT NULL DEFAULT '',
    parent_contact_number NVARCHAR(60) NOT NULL DEFAULT '',
    parent_email NVARCHAR(150) NOT NULL DEFAULT '',
    parent_facebook NVARCHAR(200) NOT NULL DEFAULT '',
    image_path NVARCHAR(255) NULL,
    subjects_json NVARCHAR(MAX) NULL,
    support_json NVARCHAR(MAX) NULL,
    extra_json NVARCHAR(MAX) NULL,
    accepted_submission_id INT NULL,
    accepted_at DATETIME2 NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_users_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_users_scope_branch FOREIGN KEY (assistant_scope_branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_users_submission FOREIGN KEY (accepted_submission_id) REFERENCES dbo.submissions(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.notifications', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.notifications (
    id INT IDENTITY(1,1) PRIMARY KEY,
    submission_id INT NOT NULL,
    title NVARCHAR(180) NOT NULL,
    message NVARCHAR(MAX) NULL,
    is_read BIT NOT NULL DEFAULT 0,
    is_archived BIT NOT NULL DEFAULT 0,
    moved_to_history BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_notifications_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.user_subject_assignments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_subject_assignments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    tutor_id INT NULL,
    subject_id INT NOT NULL,
    branch_id INT NULL,
    enrolled_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    assigned_at DATETIME2 NULL,
    accepted_by INT NULL,
    time_slot NVARCHAR(50) NULL,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_assignments_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_assignments_tutor FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_assignments_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_assignments_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_assignments_admin FOREIGN KEY (accepted_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.attendance', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.attendance (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    tutor_id INT NOT NULL,
    subject_id INT NOT NULL,
    attendance_date DATE NOT NULL,
    status NVARCHAR(20) NOT NULL CHECK (status IN ('present','absent')),
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT uniq_attendance UNIQUE (student_id, tutor_id, subject_id, attendance_date),
    CONSTRAINT fk_attendance_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_attendance_tutor FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_attendance_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.billing', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.billing (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL UNIQUE,
    full_bill DECIMAL(10,2) NOT NULL DEFAULT 1800.00,
    partial_payment DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    for_settlement DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    payment_due DATE NULL,
    payment_status NVARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
    last_paid_at DATETIME2 NULL,
    posted_by INT NULL,
    soa_posted_at DATETIME2 NULL,
    soa_type NVARCHAR(100) NULL,
    notes NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_billing_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_billing_admin FOREIGN KEY (posted_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.payment_history', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.payment_history (
    id INT IDENTITY(1,1) PRIMARY KEY,
    billing_id INT NOT NULL,
    student_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    paid_at DATETIME2 NOT NULL,
    recorded_by INT NULL,
    payment_method NVARCHAR(50) NULL,
    provider_reference NVARCHAR(255) NULL,
    transaction_type NVARCHAR(100) NULL,
    payment_status NVARCHAR(50) NULL,
    balance_after DECIMAL(10,2) NULL,
    remarks NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_payment_billing FOREIGN KEY (billing_id) REFERENCES dbo.billing(id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_payment_admin FOREIGN KEY (recorded_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.soa_posts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.soa_posts (
    id INT IDENTITY(1,1) PRIMARY KEY,
    billing_id INT NOT NULL,
    student_id INT NOT NULL,
    branch_id INT NULL,
    student_user_id NVARCHAR(50) NOT NULL,
    student_full_name NVARCHAR(255) NOT NULL,
    address NVARCHAR(MAX) NULL,
    contact_number NVARCHAR(60) NOT NULL DEFAULT '',
    statement_date DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    full_bill DECIMAL(10,2) NOT NULL DEFAULT 1800.00,
    partial_payment DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    for_settlement DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    payment_due DATE NULL,
    soa_type NVARCHAR(100) NULL,
    created_by INT NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_soa_billing FOREIGN KEY (billing_id) REFERENCES dbo.billing(id) ON DELETE CASCADE,
    CONSTRAINT fk_soa_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_soa_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_soa_admin FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.subject_resources', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.subject_resources (
    id INT IDENTITY(1,1) PRIMARY KEY,
    subject_id INT NOT NULL,
    tutor_id INT NOT NULL,
    title NVARCHAR(200) NOT NULL,
    description NVARCHAR(MAX) NULL,
    file_path NVARCHAR(255) NULL,
    file_type NVARCHAR(120) NOT NULL DEFAULT '',
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_resources_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_resources_tutor FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.messages', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.messages (
    id INT IDENTITY(1,1) PRIMARY KEY,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    body NVARCHAR(MAX) NULL,
    file_path NVARCHAR(255) NULL,
    file_original_name NVARCHAR(255) NULL,
    file_type NVARCHAR(120) NOT NULL DEFAULT '',
    is_seen BIT NOT NULL DEFAULT 0,
    is_unsent BIT NOT NULL DEFAULT 0,
    edited_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.assessments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    title NVARCHAR(200) NOT NULL,
    assessment_type NVARCHAR(10) NOT NULL CHECK (assessment_type IN ('pre','post')),
    branch_id INT NULL,
    assigned_student_id INT NOT NULL,
    created_by INT NULL,
    is_published BIT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_assessment_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_assessment_student FOREIGN KEY (assigned_student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_assessment_admin FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF OBJECT_ID('dbo.assessment_questions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_questions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    question_text NVARCHAR(MAX) NOT NULL,
    choice_a NVARCHAR(255) NOT NULL,
    choice_b NVARCHAR(255) NOT NULL,
    choice_c NVARCHAR(255) NOT NULL,
    choice_d NVARCHAR(255) NOT NULL,
    correct_answer NVARCHAR(255) NOT NULL,
    points INT NOT NULL DEFAULT 1,
    question_type NVARCHAR(100) NULL DEFAULT 'Multiple Choice',
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_questions_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.assessment_results', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_results (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    score INT NOT NULL,
    total_questions INT NOT NULL,
    percentage DECIMAL(5,2) NOT NULL,
    level NVARCHAR(20) NOT NULL CHECK (level IN ('Beginner','Intermediate','Advance')),
    answers_json NVARCHAR(MAX) NULL,
    attempt_id INT NULL,
    taken_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT uniq_assessment_result UNIQUE (assessment_id, student_id),
    CONSTRAINT fk_results_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_results_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;


IF COL_LENGTH('dbo.subject_resources', 'created_by_role') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD created_by_role NVARCHAR(30) NOT NULL CONSTRAINT df_subject_resources_created_by_role DEFAULT 'tutor';
END;

IF COL_LENGTH('dbo.subject_resources', 'assigned_student_id') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD assigned_student_id INT NULL;
  ALTER TABLE dbo.subject_resources ADD CONSTRAINT fk_resources_assigned_student FOREIGN KEY (assigned_student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION;
END;

IF COL_LENGTH('dbo.subject_resources', 'source_resource_id') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD source_resource_id INT NULL;
  ALTER TABLE dbo.subject_resources ADD CONSTRAINT fk_resources_source_resource FOREIGN KEY (source_resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION;
END;

IF COL_LENGTH('dbo.assessments', 'subject_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD subject_id INT NULL;
  ALTER TABLE dbo.assessments ADD CONSTRAINT fk_assessment_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION;
END;

IF COL_LENGTH('dbo.assessments', 'source_template_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD source_template_id INT NULL;
END;

IF COL_LENGTH('dbo.assessments', 'assigned_by_tutor_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD assigned_by_tutor_id INT NULL;
  ALTER TABLE dbo.assessments ADD CONSTRAINT fk_assessment_assigned_tutor FOREIGN KEY (assigned_by_tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION;
END;

IF OBJECT_ID('dbo.assessment_templates', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_templates (
    id INT IDENTITY(1,1) PRIMARY KEY,
    subject_id INT NOT NULL,
    title NVARCHAR(200) NOT NULL,
    assessment_type NVARCHAR(10) NOT NULL CHECK (assessment_type IN ('pre','post')),
    target_subject_ids_json NVARCHAR(MAX) NULL,
    target_year_levels_json NVARCHAR(MAX) NULL,
    target_grade_levels_json NVARCHAR(MAX) NULL,
    type_of_assessment_json NVARCHAR(MAX) NULL,
    created_by INT NULL,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_assessment_templates_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_assessment_templates_admin FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF COL_LENGTH('dbo.assessment_templates', 'target_subject_ids_json') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_templates ADD target_subject_ids_json NVARCHAR(MAX) NULL;
END;

IF COL_LENGTH('dbo.assessment_templates', 'target_year_levels_json') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_templates ADD target_year_levels_json NVARCHAR(MAX) NULL;
END;

IF COL_LENGTH('dbo.assessment_templates', 'target_grade_levels_json') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_templates ADD target_grade_levels_json NVARCHAR(MAX) NULL;
END;

IF OBJECT_ID('dbo.assessment_template_questions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_template_questions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    template_id INT NOT NULL,
    question_text NVARCHAR(MAX) NOT NULL,
    choice_a NVARCHAR(255) NOT NULL,
    choice_b NVARCHAR(255) NOT NULL,
    choice_c NVARCHAR(255) NOT NULL,
    choice_d NVARCHAR(255) NOT NULL,
    correct_answer NVARCHAR(255) NOT NULL,
    points INT NOT NULL DEFAULT 1,
    question_type NVARCHAR(100) NULL DEFAULT 'Multiple Choice',
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_template_questions_template FOREIGN KEY (template_id) REFERENCES dbo.assessment_templates(id) ON DELETE CASCADE
  );
END;


IF OBJECT_ID('dbo.tutor_year_levels', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_year_levels (
    id INT IDENTITY(1,1) PRIMARY KEY,
    tutor_id INT NOT NULL,
    year_level NVARCHAR(50) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_tutor_year_levels_user FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.otps', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.otps (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL,
    purpose NVARCHAR(40) NOT NULL DEFAULT 'login',
    otp_code NVARCHAR(255) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    is_used BIT NOT NULL DEFAULT 0,
    used_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_otps_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.email_otps', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.email_otps (
    id INT IDENTITY(1,1) PRIMARY KEY,
    email NVARCHAR(150) NOT NULL,
    purpose NVARCHAR(40) NOT NULL,
    otp_hash NVARCHAR(255) NOT NULL,
    target_type NVARCHAR(30) NULL,
    target_id INT NULL,
    metadata_json NVARCHAR(MAX) NULL,
    expires_at DATETIME2 NOT NULL,
    used_at DATETIME2 NULL,
    is_used BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE())
  );
END;

IF OBJECT_ID('dbo.trusted_devices', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.trusted_devices (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL,
    device_token NVARCHAR(128) NOT NULL,
    device_fingerprint NVARCHAR(255) NOT NULL,
    user_agent NVARCHAR(255) NULL,
    last_used_at DATETIME2 NULL,
    expires_at DATETIME2 NULL,
    is_active BIT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_trusted_devices_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_trusted_devices_user_token' AND object_id = OBJECT_ID('dbo.trusted_devices'))
BEGIN
  CREATE UNIQUE INDEX idx_trusted_devices_user_token ON dbo.trusted_devices(user_id, device_token);
END;

IF COL_LENGTH('dbo.trusted_devices', 'expires_at') IS NULL
BEGIN
  ALTER TABLE dbo.trusted_devices ADD expires_at DATETIME2 NULL;
END;

UPDATE dbo.trusted_devices
SET expires_at = DATEADD(DAY, 30, COALESCE(last_used_at, created_at))
WHERE expires_at IS NULL;



IF OBJECT_ID('dbo.subject_enrollment_requests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.subject_enrollment_requests (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    branch_id INT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
    decided_by INT NULL,
    decided_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_subject_requests_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
    CONSTRAINT fk_subject_requests_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_subject_requests_branch FOREIGN KEY (branch_id) REFERENCES dbo.branches(id) ON DELETE NO ACTION,
    CONSTRAINT fk_subject_requests_admin FOREIGN KEY (decided_by) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;


IF OBJECT_ID('dbo.tutor_schedule_applications', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_schedule_applications (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    tutor_id INT NOT NULL,
    subject_id INT NOT NULL,
    branch_id INT NULL,
    time_slot NVARCHAR(50) NOT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending',
    student_notified BIT NOT NULL DEFAULT 0,
    decided_by INT NULL,
    decided_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE())
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tutor_schedule_applications_tutor_status' AND object_id = OBJECT_ID('dbo.tutor_schedule_applications'))
  CREATE INDEX IX_tutor_schedule_applications_tutor_status ON dbo.tutor_schedule_applications(tutor_id, status, time_slot);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tutor_schedule_applications_student_status' AND object_id = OBJECT_ID('dbo.tutor_schedule_applications'))
  CREATE INDEX IX_tutor_schedule_applications_student_status ON dbo.tutor_schedule_applications(student_id, status);


-- ============================================================================
-- AI SYSTEM — Phase 1 Migrations
-- ============================================================================

-- 1. FIX: assessment_results.level CHECK (Balance → Intermediate)
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
BEGIN
  DECLARE @ck_ar SYSNAME, @drop_ar NVARCHAR(MAX);
  SET @ck_ar = NULL;
  SELECT TOP 1 @ck_ar = dc.name
    FROM sys.check_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.assessment_results') AND c.name = 'level';
  IF @ck_ar IS NOT NULL
  BEGIN
    SET @drop_ar = N'ALTER TABLE dbo.assessment_results DROP CONSTRAINT ' + QUOTENAME(@ck_ar);
    BEGIN TRY EXEC sp_executesql @drop_ar; END TRY BEGIN CATCH END CATCH;
  END
END

IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
  UPDATE dbo.assessment_results SET level = 'Intermediate' WHERE level = 'Balance';

IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL
   AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_assessment_results_level' AND parent_object_id = OBJECT_ID('dbo.assessment_results'))
  ALTER TABLE dbo.assessment_results ADD CONSTRAINT CK_assessment_results_level CHECK (level IN ('Beginner','Intermediate','Advance'));


-- 2. subject_resources — New AI/module columns
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','type_of_module') IS NULL
  ALTER TABLE dbo.subject_resources ADD type_of_module NVARCHAR(60) NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','module_origin') IS NULL
  ALTER TABLE dbo.subject_resources ADD module_origin NVARCHAR(30) NOT NULL CONSTRAINT df_sr_module_origin DEFAULT 'admin_upload';

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','difficulty_level') IS NULL
  ALTER TABLE dbo.subject_resources ADD difficulty_level NVARCHAR(20) NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','content_text') IS NULL
  ALTER TABLE dbo.subject_resources ADD content_text NVARCHAR(MAX) NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generated_from_assessment_id') IS NULL
  ALTER TABLE dbo.subject_resources ADD generated_from_assessment_id INT NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generated_from_result_id') IS NULL
  ALTER TABLE dbo.subject_resources ADD generated_from_result_id INT NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generation_round') IS NULL
  ALTER TABLE dbo.subject_resources ADD generation_round INT NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','next_assessment_due_at') IS NULL
  ALTER TABLE dbo.subject_resources ADD next_assessment_due_at DATETIME2 NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','is_archived') IS NULL
  ALTER TABLE dbo.subject_resources ADD is_archived BIT NOT NULL CONSTRAINT df_sr_is_archived DEFAULT 0;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','archived_at') IS NULL
  ALTER TABLE dbo.subject_resources ADD archived_at DATETIME2 NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','recovered_at') IS NULL
  ALTER TABLE dbo.subject_resources ADD recovered_at DATETIME2 NULL;

IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','updated_at') IS NULL
  ALTER TABLE dbo.subject_resources ADD updated_at DATETIME2 NOT NULL CONSTRAINT df_sr_updated_at DEFAULT DATEADD(hour, 8, GETUTCDATE());


-- 3. users — education_level_group
IF OBJECT_ID('dbo.users','U') IS NOT NULL AND COL_LENGTH('dbo.users','education_level_group') IS NULL
  ALTER TABLE dbo.users ADD education_level_group NVARCHAR(60) NULL;

IF OBJECT_ID('dbo.users','U') IS NOT NULL AND COL_LENGTH('dbo.users','education_level_group') IS NOT NULL
  UPDATE dbo.users SET education_level_group = year_level
    WHERE education_level_group IS NULL AND year_level IS NOT NULL AND LTRIM(RTRIM(year_level)) <> '';


-- 4. submissions — education_level_group
IF OBJECT_ID('dbo.submissions','U') IS NOT NULL AND COL_LENGTH('dbo.submissions','education_level_group') IS NULL
  ALTER TABLE dbo.submissions ADD education_level_group NVARCHAR(60) NULL;


-- 5. assessment_questions — AI grading columns
IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','answer_rubric') IS NULL
  ALTER TABLE dbo.assessment_questions ADD answer_rubric NVARCHAR(MAX) NULL;

IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','explanation') IS NULL
  ALTER TABLE dbo.assessment_questions ADD explanation NVARCHAR(MAX) NULL;


-- 6. assessment_template_questions — AI grading columns
IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_template_questions','answer_rubric') IS NULL
  ALTER TABLE dbo.assessment_template_questions ADD answer_rubric NVARCHAR(MAX) NULL;

IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_template_questions','explanation') IS NULL
  ALTER TABLE dbo.assessment_template_questions ADD explanation NVARCHAR(MAX) NULL;


-- 7. NEW TABLE: module_reads
IF OBJECT_ID('dbo.module_reads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.module_reads (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    resource_id INT NOT NULL,
    subject_id INT NOT NULL,
    read_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_module_reads_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_module_reads_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE CASCADE,
    CONSTRAINT fk_module_reads_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION,
    CONSTRAINT uniq_module_read UNIQUE (student_id, resource_id)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_module_reads_student_subject' AND object_id = OBJECT_ID('dbo.module_reads'))
  CREATE INDEX IX_module_reads_student_subject ON dbo.module_reads(student_id, subject_id);


-- 8. NEW TABLE: assessment_attempts
IF OBJECT_ID('dbo.assessment_attempts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_attempts (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    score INT NOT NULL DEFAULT 0,
    total_questions INT NOT NULL DEFAULT 0,
    percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    level NVARCHAR(20) NOT NULL DEFAULT 'Beginner' CHECK (level IN ('Beginner','Intermediate','Advance')),
    answers_json NVARCHAR(MAX) NULL,
    started_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    submitted_at DATETIME2 NULL,
    is_auto_submitted BIT NOT NULL DEFAULT 0,
    auto_submit_reason NVARCHAR(100) NULL,
    time_spent_seconds INT NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_attempts_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_attempts_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_assessment_attempts_student' AND object_id = OBJECT_ID('dbo.assessment_attempts'))
  CREATE INDEX IX_assessment_attempts_student ON dbo.assessment_attempts(student_id, assessment_id);


-- 9. NEW TABLE: student_assessment_answers
IF OBJECT_ID('dbo.student_assessment_answers', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.student_assessment_answers (
    id INT IDENTITY(1,1) PRIMARY KEY,
    attempt_id INT NOT NULL,
    question_id INT NOT NULL,
    student_answer NVARCHAR(MAX) NULL,
    is_correct BIT NOT NULL DEFAULT 0,
    points_earned DECIMAL(5,2) NOT NULL DEFAULT 0,
    ai_feedback NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_saa_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE CASCADE,
    CONSTRAINT fk_saa_question FOREIGN KEY (question_id) REFERENCES dbo.assessment_questions(id) ON DELETE NO ACTION
  );
END;


-- 10. NEW TABLE: assessment_anti_cheat_logs
IF OBJECT_ID('dbo.assessment_anti_cheat_logs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_anti_cheat_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    attempt_id INT NULL,
    event_type NVARCHAR(50) NOT NULL,
    event_detail NVARCHAR(MAX) NULL,
    violation_count INT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_acl_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_acl_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_acl_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_anti_cheat_logs_assessment' AND object_id = OBJECT_ID('dbo.assessment_anti_cheat_logs'))
  CREATE INDEX IX_anti_cheat_logs_assessment ON dbo.assessment_anti_cheat_logs(assessment_id, student_id);


-- 11. NEW TABLE: student_learning_cycles
IF OBJECT_ID('dbo.student_learning_cycles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.student_learning_cycles (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    resource_id INT NULL,
    assessment_id INT NULL,
    attempt_id INT NULL,
    round_number INT NOT NULL DEFAULT 1,
    status NVARCHAR(30) NOT NULL DEFAULT 'reading' CHECK (status IN ('reading','assessment_pending','assessment_taken','module_generated','completed')),
    result_level NVARCHAR(20) NULL,
    started_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    completed_at DATETIME2 NULL,
    next_due_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_slc_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_slc_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_learning_cycles_student_subject' AND object_id = OBJECT_ID('dbo.student_learning_cycles'))
  CREATE INDEX IX_learning_cycles_student_subject ON dbo.student_learning_cycles(student_id, subject_id, status);


-- 12. NEW TABLE: ai_generation_logs
IF OBJECT_ID('dbo.ai_generation_logs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_generation_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    generation_type NVARCHAR(50) NOT NULL,
    student_id INT NULL,
    subject_id INT NULL,
    resource_id INT NULL,
    assessment_id INT NULL,
    input_summary NVARCHAR(MAX) NULL,
    output_summary NVARCHAR(MAX) NULL,
    ai_provider NVARCHAR(50) NULL,
    ai_model NVARCHAR(100) NULL,
    tokens_used INT NULL,
    success BIT NOT NULL DEFAULT 1,
    error_message NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_ailog_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE NO ACTION
  );
END;


-- 13. NEW TABLE: online_payments
IF OBJECT_ID('dbo.online_payments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.online_payments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    billing_id INT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_method NVARCHAR(50) NOT NULL DEFAULT 'online',
    provider NVARCHAR(100) NULL,
    provider_reference NVARCHAR(255) NULL,
    status NVARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','refunded')),
    notes NVARCHAR(MAX) NULL,
    paid_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_op_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_op_billing FOREIGN KEY (billing_id) REFERENCES dbo.billing(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_online_payments_student' AND object_id = OBJECT_ID('dbo.online_payments'))
  CREATE INDEX IX_online_payments_student ON dbo.online_payments(student_id, status);


-- 14. payment_history — New columns for online payment tracking
IF OBJECT_ID('dbo.payment_history','U') IS NOT NULL AND COL_LENGTH('dbo.payment_history','payment_method') IS NULL
  ALTER TABLE dbo.payment_history ADD payment_method NVARCHAR(50) NULL;

IF OBJECT_ID('dbo.payment_history','U') IS NOT NULL AND COL_LENGTH('dbo.payment_history','provider_reference') IS NULL
  ALTER TABLE dbo.payment_history ADD provider_reference NVARCHAR(255) NULL;


-- 15. assessments — AI/cycle columns
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','source_resource_id') IS NULL
  ALTER TABLE dbo.assessments ADD source_resource_id INT NULL;

IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','assessment_origin') IS NULL
  ALTER TABLE dbo.assessments ADD assessment_origin NVARCHAR(30) NOT NULL CONSTRAINT df_assessments_origin DEFAULT 'manual';

IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','cycle_id') IS NULL
  ALTER TABLE dbo.assessments ADD cycle_id INT NULL;

IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','time_limit_minutes') IS NULL
  ALTER TABLE dbo.assessments ADD time_limit_minutes INT NULL;

IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','max_violations') IS NULL
  ALTER TABLE dbo.assessments ADD max_violations INT NOT NULL CONSTRAINT df_assessments_max_violations DEFAULT 3;


-- 16. Filtered unique index on user_subject_assignments
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_usa_unique_active' AND object_id = OBJECT_ID('dbo.user_subject_assignments'))
BEGIN
  BEGIN TRY
    CREATE UNIQUE INDEX IX_usa_unique_active ON dbo.user_subject_assignments(student_id, subject_id) WHERE is_archived = 0;
  END TRY
  BEGIN CATCH
    PRINT 'Warning: Could not create IX_usa_unique_active — possible existing duplicates.';
  END CATCH
END


-- 17. assessment_results — attempt_id link
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','attempt_id') IS NULL
  ALTER TABLE dbo.assessment_results ADD attempt_id INT NULL;


-- 18. Widen correct_answer columns for AI-generated questions (True/False, Identification)
-- assessment_questions: drop old CHECK, widen from NCHAR(1) to NVARCHAR(255)
IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL
BEGIN
  DECLARE @ck_aq SYSNAME, @drop_aq NVARCHAR(MAX);
  SET @ck_aq = NULL;
  SELECT TOP 1 @ck_aq = dc.name
    FROM sys.check_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.assessment_questions') AND c.name = 'correct_answer';
  IF @ck_aq IS NOT NULL
  BEGIN
    SET @drop_aq = N'ALTER TABLE dbo.assessment_questions DROP CONSTRAINT ' + QUOTENAME(@ck_aq);
    BEGIN TRY EXEC sp_executesql @drop_aq; END TRY BEGIN CATCH END CATCH;
  END
END

IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL
   AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='assessment_questions' AND COLUMN_NAME='correct_answer' AND CHARACTER_MAXIMUM_LENGTH < 255)
  ALTER TABLE dbo.assessment_questions ALTER COLUMN correct_answer NVARCHAR(255) NOT NULL;

-- assessment_template_questions: same fix
IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL
BEGIN
  DECLARE @ck_atq SYSNAME, @drop_atq NVARCHAR(MAX);
  SET @ck_atq = NULL;
  SELECT TOP 1 @ck_atq = dc.name
    FROM sys.check_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.assessment_template_questions') AND c.name = 'correct_answer';
  IF @ck_atq IS NOT NULL
  BEGIN
    SET @drop_atq = N'ALTER TABLE dbo.assessment_template_questions DROP CONSTRAINT ' + QUOTENAME(@ck_atq);
    BEGIN TRY EXEC sp_executesql @drop_atq; END TRY BEGIN CATCH END CATCH;
  END
END

IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL
   AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='assessment_template_questions' AND COLUMN_NAME='correct_answer' AND CHARACTER_MAXIMUM_LENGTH < 255)
  ALTER TABLE dbo.assessment_template_questions ALTER COLUMN correct_answer NVARCHAR(255) NOT NULL;


-- ============================================================================
-- Phase 3 Migrations: Assessment Requests & PayMongo
-- ============================================================================

-- 19. NEW TABLE: assessment_requests (tutor approval workflow)
IF OBJECT_ID('dbo.assessment_requests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_requests (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    tutor_id INT NOT NULL,
    subject_id INT NOT NULL,
    resource_id INT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
    requested_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    responded_at DATETIME2 NULL,
    tutor_message NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_ar_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ar_tutor FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ar_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_assessment_requests_student' AND object_id = OBJECT_ID('dbo.assessment_requests'))
  CREATE INDEX IX_assessment_requests_student ON dbo.assessment_requests(student_id, status);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_assessment_requests_tutor' AND object_id = OBJECT_ID('dbo.assessment_requests'))
  CREATE INDEX IX_assessment_requests_tutor ON dbo.assessment_requests(tutor_id, status);


-- 20. online_payments — PayMongo columns
IF OBJECT_ID('dbo.online_payments','U') IS NOT NULL AND COL_LENGTH('dbo.online_payments','checkout_url') IS NULL
  ALTER TABLE dbo.online_payments ADD checkout_url NVARCHAR(500) NULL;

IF OBJECT_ID('dbo.online_payments','U') IS NOT NULL AND COL_LENGTH('dbo.online_payments','billing_name') IS NULL
  ALTER TABLE dbo.online_payments ADD billing_name NVARCHAR(200) NULL;

IF OBJECT_ID('dbo.online_payments','U') IS NOT NULL AND COL_LENGTH('dbo.online_payments','billing_email') IS NULL
  ALTER TABLE dbo.online_payments ADD billing_email NVARCHAR(200) NULL;

IF OBJECT_ID('dbo.online_payments','U') IS NOT NULL AND COL_LENGTH('dbo.online_payments','billing_phone') IS NULL
  ALTER TABLE dbo.online_payments ADD billing_phone NVARCHAR(50) NULL;


-- 21. assessment_requests — item_count column (tutor-specified number of items)
IF OBJECT_ID('dbo.assessment_requests','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_requests','item_count') IS NULL
  ALTER TABLE dbo.assessment_requests ADD item_count INT NULL;

-- 22. assessments — additional AI columns
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','assessment_origin') IS NULL
  ALTER TABLE dbo.assessments ADD assessment_origin NVARCHAR(50) NULL CONSTRAINT df_assessments_origin DEFAULT 'manual';

IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','source_module_title') IS NULL
  ALTER TABLE dbo.assessments ADD source_module_title NVARCHAR(200) NULL;

-- 23. assessment_questions — additional AI columns
IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','essay_rubric_keywords') IS NULL
  ALTER TABLE dbo.assessment_questions ADD essay_rubric_keywords NVARCHAR(MAX) NULL;

IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','source_module_title') IS NULL
  ALTER TABLE dbo.assessment_questions ADD source_module_title NVARCHAR(200) NULL;

-- 24. assessment_results — per-module breakdown
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','per_module_scores_json') IS NULL
  ALTER TABLE dbo.assessment_results ADD per_module_scores_json NVARCHAR(MAX) NULL;

-- 25. assessment_template_questions — additional AI columns
IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_template_questions','essay_rubric_keywords') IS NULL
  ALTER TABLE dbo.assessment_template_questions ADD essay_rubric_keywords NVARCHAR(MAX) NULL;


-- ============================================================================
-- Phase 4: Module Management & Tutor Assessment System
-- ============================================================================

-- 26. NEW TABLE: modules — Admin-uploaded learning modules per subject + level
IF OBJECT_ID('dbo.modules', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.modules (
    id INT IDENTITY(1,1) PRIMARY KEY,
    subject_id INT NOT NULL,
    level NVARCHAR(20) NOT NULL CHECK (level IN ('Beginner','Intermediate','Advanced')),
    title NVARCHAR(200) NOT NULL,
    description NVARCHAR(MAX) NULL,
    file_path NVARCHAR(500) NULL,
    file_original_name NVARCHAR(255) NULL,
    file_type NVARCHAR(120) NULL,
    uploaded_by INT NULL,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_modules_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_modules_uploader FOREIGN KEY (uploaded_by) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT uniq_module_subject_level UNIQUE (subject_id, level)
  );
END;

-- 27. NEW TABLE: student_subject_levels — Per-subject level assignment from Pre-Assessment
IF OBJECT_ID('dbo.student_subject_levels', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.student_subject_levels (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    level NVARCHAR(20) NOT NULL CHECK (level IN ('Beginner','Intermediate','Advanced')),
    pre_assessment_id INT NULL,
    score INT NULL,
    total_points INT NULL,
    percentage DECIMAL(5,2) NULL,
    assigned_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_ssl_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ssl_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT uniq_ssl_student_subject UNIQUE (student_id, subject_id)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ssl_student_subject' AND object_id = OBJECT_ID('dbo.student_subject_levels'))
  CREATE INDEX IX_ssl_student_subject ON dbo.student_subject_levels(student_id, subject_id);

-- 28. NEW TABLE: tutor_assessments — Tutor-created assessments tied to Subject > Module > Level
IF OBJECT_ID('dbo.tutor_assessments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_assessments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    subject_id INT NOT NULL,
    module_id INT NOT NULL,
    tutor_id INT NOT NULL,
    title NVARCHAR(200) NOT NULL,
    instructions NVARCHAR(MAX) NULL,
    purpose NVARCHAR(20) NOT NULL CHECK (purpose IN ('pre','activity','post')),
    is_published BIT NOT NULL DEFAULT 1,
    is_archived BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_ta_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ta_module FOREIGN KEY (module_id) REFERENCES dbo.modules(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ta_tutor FOREIGN KEY (tutor_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ta_subject_module' AND object_id = OBJECT_ID('dbo.tutor_assessments'))
  CREATE INDEX IX_ta_subject_module ON dbo.tutor_assessments(subject_id, module_id, purpose);

-- 29. NEW TABLE: tutor_assessment_questions — Questions for tutor assessments
IF OBJECT_ID('dbo.tutor_assessment_questions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_assessment_questions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    question_text NVARCHAR(MAX) NOT NULL,
    question_type NVARCHAR(30) NOT NULL CHECK (question_type IN ('multiple_choice','true_false','fill_blank')),
    points INT NOT NULL DEFAULT 1,
    correct_answer NVARCHAR(500) NOT NULL,
    explanation NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_taq_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.tutor_assessments(id) ON DELETE CASCADE
  );
END;

-- 30. NEW TABLE: tutor_question_options — MCQ choices
IF OBJECT_ID('dbo.tutor_question_options', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_question_options (
    id INT IDENTITY(1,1) PRIMARY KEY,
    question_id INT NOT NULL,
    option_label NVARCHAR(10) NOT NULL,
    option_text NVARCHAR(500) NOT NULL,
    CONSTRAINT fk_tqo_question FOREIGN KEY (question_id) REFERENCES dbo.tutor_assessment_questions(id) ON DELETE CASCADE
  );
END;

-- 31. NEW TABLE: tutor_assessment_submissions — Student submissions
IF OBJECT_ID('dbo.tutor_assessment_submissions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_assessment_submissions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    score INT NOT NULL DEFAULT 0,
    total_points INT NOT NULL DEFAULT 0,
    percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
    submitted_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_tas_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.tutor_assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_tas_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tas_student_assessment' AND object_id = OBJECT_ID('dbo.tutor_assessment_submissions'))
  CREATE INDEX IX_tas_student_assessment ON dbo.tutor_assessment_submissions(student_id, assessment_id);

-- 32. NEW TABLE: tutor_student_answers — Individual answers per submission
IF OBJECT_ID('dbo.tutor_student_answers', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_student_answers (
    id INT IDENTITY(1,1) PRIMARY KEY,
    submission_id INT NOT NULL,
    question_id INT NOT NULL,
    student_answer NVARCHAR(MAX) NULL,
    correct_answer NVARCHAR(500) NOT NULL,
    is_correct BIT NOT NULL DEFAULT 0,
    points_earned INT NOT NULL DEFAULT 0,
    CONSTRAINT fk_tsa_submission FOREIGN KEY (submission_id) REFERENCES dbo.tutor_assessment_submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_tsa_question FOREIGN KEY (question_id) REFERENCES dbo.tutor_assessment_questions(id) ON DELETE NO ACTION
  );
END;

