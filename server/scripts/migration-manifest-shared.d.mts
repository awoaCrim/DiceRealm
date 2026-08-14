export interface MigrationManifestEntry {
  name: string;
  sha256: string;
}

export interface MigrationManifestReport {
  files: MigrationManifestEntry[];
}

export declare const CANONICAL_MIGRATION_FILENAME_PATTERN: RegExp;

export declare function isCanonicalMigrationFilename(name: string): boolean;

export declare function sortMigrationFilenames(names: string[]): string[];

export declare function normalizeMigrationText(text: string): string;

export declare function sha256OfMigrationText(text: string): string;

export declare function verifyMigrationManifestSync(options: {
  migrationsDir: string;
  manifestPath: string;
}): MigrationManifestReport;
