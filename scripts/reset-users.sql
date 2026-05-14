-- ANNOTATED COPY FOR DEFENSE REVIEW
-- File: scripts/reset-users.sql
-- Purpose: SQL script used by the project.

USE [mindquest1_db];
GO

DECLARE @AdminEmail NVARCHAR(150) = 'admin@mindquest.local';
DECLARE @AdminPasswordHash NVARCHAR(255) = '$2a$10$RTCAOSJo./9g0wfWOwjDTelg7ko5zMiHv1uGrnDufAQ.kfmSHDBm2';
-- Plain password for the hash above: Admin@12345

SET NOCOUNT ON;

DELETE FROM dbo.notifications;
DELETE FROM dbo.payment_history;
DELETE FROM dbo.soa_posts;
DELETE FROM dbo.attendance;
DELETE FROM dbo.messages;
DELETE FROM dbo.assessment_results;
DELETE FROM dbo.assessment_questions;
DELETE FROM dbo.assessments;
DELETE FROM dbo.user_subject_assignments;
DELETE FROM dbo.billing;
DELETE FROM dbo.submissions;
DELETE FROM dbo.subject_resources;

DELETE FROM dbo.users WHERE role <> 'admin';

IF EXISTS (SELECT 1 FROM dbo.users WHERE role = 'admin')
BEGIN
    UPDATE dbo.users
    SET email = @AdminEmail,
        password_hash = @AdminPasswordHash,
        first_name = 'System',
        middle_name = '',
        last_name = 'Administrator',
        status = 'approved',
        is_archived = 0,
        branch_id = NULL,
        assistant_scope_branch_id = NULL,
        updated_at = SYSDATETIME()
    WHERE role = 'admin';
END
ELSE
BEGIN
    INSERT INTO dbo.users (
        user_id, role, branch_id, assistant_scope_branch_id, password_hash,
        first_name, middle_name, last_name, email, contact_number, status, is_archived, created_at, updated_at
    ) VALUES (
        'ADM-0001', 'admin', NULL, NULL, @AdminPasswordHash,
        'System', '', 'Administrator', @AdminEmail, '', 'approved', 0, SYSDATETIME(), SYSDATETIME()
    );
END;

SELECT 'DEFAULT ADMIN LOGIN' AS info, @AdminEmail AS email, 'Admin@12345' AS plain_password;
GO
