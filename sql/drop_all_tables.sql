-- MindQuest — DROP ALL TABLES (Dynamic)
-- WARNING: This will DELETE ALL DATA permanently!
SET NOCOUNT ON;

-- Drop all foreign key constraints
DECLARE @dropFK NVARCHAR(MAX) = N'';
SELECT @dropFK += N'ALTER TABLE ' + QUOTENAME(s.name) + '.' + QUOTENAME(t.name)
               + N' DROP CONSTRAINT ' + QUOTENAME(f.name) + ';' + CHAR(13)
FROM sys.foreign_keys f
JOIN sys.tables t ON f.parent_object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo';
IF LEN(@dropFK) > 0 EXEC sp_executesql @dropFK;
GO

-- Drop all tables
DECLARE @dropTables NVARCHAR(MAX) = N'';
SELECT @dropTables += N'DROP TABLE ' + QUOTENAME(s.name) + '.' + QUOTENAME(t.name) + ';' + CHAR(13)
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.type = 'U';
IF LEN(@dropTables) > 0 EXEC sp_executesql @dropTables;
GO

PRINT '=== ALL TABLES DROPPED ===';
GO
