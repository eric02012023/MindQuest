-- ANNOTATED COPY FOR DEFENSE REVIEW
-- File: scripts/clear-stale-submissions.sql
-- Purpose: SQL script used by the project.

-- clear-stale-submissions.sql
-- Run this once to clean up old/archived submissions that may be blocking new registrations
USE [mindquest1_db];
GO

-- Cancel all accepted submissions (they already became users, no longer needed for duplicate check)
UPDATE dbo.submissions
SET status = 'cancelled', archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE())
WHERE status = 'accepted';

-- Archive all existing archived-flagged submissions
UPDATE dbo.submissions
SET archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE())
WHERE archived = 0 AND status IN ('accepted', 'cancelled');

SELECT 
  status,
  archived,
  COUNT(*) AS total
FROM dbo.submissions
GROUP BY status, archived
ORDER BY status, archived;
GO
