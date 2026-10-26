import { selectActiveSection, type PolicySectionRow } from "@credit/core";
import type { Sql } from "postgres";
import type {
	ActiveIndex,
	AclRow,
	PolicyChunk,
	PolicyQueryRecord,
	PolicySectionDetail,
	PolicyStore,
} from "./store.js";

function parseVector(value: string): number[] {
	const inner = value.replace(/^\[/, "").replace(/\]$/, "");
	if (inner.trim() === "") return [];
	return inner.split(",").map((part) => Number(part));
}

function num(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export function createPostgresPolicyStore(sql: Sql): PolicyStore {
	const store: PolicyStore = {
		async getActiveIndex(): Promise<ActiveIndex | null> {
			const rows = (await sql`
				SELECT index_version, embedding_model, embedding_dimensions, chunking_version
				FROM policy_index_meta
				WHERE status = 'active'
				LIMIT 1
			`) as unknown as Array<{
				index_version: string;
				embedding_model: string;
				embedding_dimensions: number;
				chunking_version: string;
			}>;
			const row = rows[0];
			if (!row) return null;
			return {
				indexVersion: row.index_version,
				embeddingModel: row.embedding_model,
				embeddingDimensions: row.embedding_dimensions,
				chunkingVersion: row.chunking_version,
			};
		},

		async loadChunks(input) {
			const rows = (await sql`
				SELECT
					c.id AS chunk_id,
					c.index_version,
					c.version_id,
					c.section_id,
					c.heading,
					c.text AS body,
					c.content_hash,
					c.embedding::text AS embedding_text,
					c.embedding_model,
					c.embedding_dimensions,
					c.chunking_version,
					d.id AS policy_id,
					d.policy_key,
					d.title,
					d.policy_family,
					d.product_scope,
					d.jurisdiction,
					v.version,
					v.status,
					v.effective_from::text AS effective_from,
					v.effective_to::text AS effective_to
				FROM policy_chunks c
				JOIN policy_versions v ON v.id = c.version_id
				JOIN policy_documents d ON d.id = v.policy_id
				WHERE c.index_version = ${input.indexVersion}
				  AND d.domain = 'credit'
				  AND v.status::text = ANY(${input.statuses}::text[])
				  AND v.effective_from <= ${input.asOf}::date
				  AND (v.effective_to IS NULL OR v.effective_to >= ${input.asOf}::date)
				  AND (d.product_scope = 'all' OR d.product_scope::text = ${input.productScope})
				  AND d.jurisdiction = ${input.jurisdiction}
			`) as unknown as Array<{
				chunk_id: string;
				index_version: string;
				version_id: string;
				section_id: string;
				heading: string;
				body: string;
				content_hash: string;
				embedding_text: string;
				embedding_model: string;
				embedding_dimensions: number;
				chunking_version: string;
				policy_id: string;
				policy_key: string;
				title: string;
				policy_family: string;
				product_scope: string;
				jurisdiction: string;
				version: string;
				status: string;
				effective_from: string;
				effective_to: string | null;
			}>;
			return rows.map((row): PolicyChunk => ({
				chunkId: row.chunk_id,
				indexVersion: row.index_version,
				policyId: row.policy_id,
				policyKey: row.policy_key,
				title: row.title,
				policyVersionId: row.version_id,
				version: row.version,
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				sectionId: row.section_id,
				heading: row.heading,
				body: row.body,
				contentHash: row.content_hash,
				policyFamily: row.policy_family,
				productScope: row.product_scope,
				jurisdiction: row.jurisdiction,
				embedding: parseVector(row.embedding_text),
				embeddingModel: row.embedding_model,
				embeddingDimensions: row.embedding_dimensions,
				chunkingVersion: row.chunking_version,
			}));
		},

		async loadAcls(policyIds) {
			if (policyIds.length === 0) return [];
			const rows = (await sql`
				SELECT policy_id AS "policyId", principal_type AS "principalType", principal, permission
				FROM policy_acl
				WHERE revoked_at IS NULL
				  AND policy_id = ANY(${policyIds}::uuid[])
			`) as unknown as AclRow[];
			return rows;
		},

		async loadPolicyRoles(userId) {
			const rows = (await sql`
				SELECT role
				FROM policy_roles
				WHERE user_id = ${userId} AND revoked_at IS NULL
			`) as unknown as Array<{ role: "policy_owner" | "compliance" }>;
			return rows.map((row) => row.role);
		},

		async getSection(versionId, sectionId): Promise<PolicySectionDetail | null> {
			const rows = (await sql`
				SELECT
					s.section_id, s.heading, s.body,
					v.id AS version_id, v.version, v.status,
					v.effective_from::text AS effective_from,
					v.effective_to::text AS effective_to,
					d.id AS policy_id, d.policy_key, d.title
				FROM policy_sections s
				JOIN policy_versions v ON v.id = s.version_id
				JOIN policy_documents d ON d.id = v.policy_id
				WHERE s.version_id = ${versionId} AND s.section_id = ${sectionId}
				LIMIT 1
			`) as unknown as Array<{
				section_id: string;
				heading: string;
				body: string;
				version_id: string;
				version: string;
				status: string;
				effective_from: string;
				effective_to: string | null;
				policy_id: string;
				policy_key: string;
				title: string;
			}>;
			const row = rows[0];
			if (!row) return null;
			const neighbours = (await sql`
				SELECT section_id, heading
				FROM policy_sections
				WHERE version_id = ${versionId}
				ORDER BY order_index
			`) as unknown as Array<{ section_id: string; heading: string }>;
			return {
				policyId: row.policy_id,
				policyKey: row.policy_key,
				title: row.title,
				policyVersionId: row.version_id,
				version: row.version,
				status: row.status,
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				sectionId: row.section_id,
				heading: row.heading,
				body: row.body,
				neighbours: neighbours.map((n) => ({ sectionId: n.section_id, heading: n.heading })),
			};
		},

		async getSectionByRef(input): Promise<PolicySectionRow | null> {
			const rows = (await sql`
				SELECT
					d.id AS policy_id, d.policy_key, d.title,
					v.id AS version_id, v.version, v.status::text AS status,
					v.effective_from::text AS effective_from,
					v.effective_to::text AS effective_to,
					s.section_id, s.heading, s.body, s.content_hash,
					d.policy_family, d.product_scope::text AS product_scope,
					d.jurisdiction, d.domain::text AS domain
				FROM policy_sections s
				JOIN policy_versions v ON v.id = s.version_id
				JOIN policy_documents d ON d.id = v.policy_id
				WHERE d.policy_key = ${input.policyKey}
				  AND s.section_id = ${input.sectionId}
				  AND v.status IN ('approved', 'retired')
				  ${input.versionId ? sql`AND v.id = ${input.versionId}` : sql``}
			`) as unknown as Array<{
				policy_id: string;
				policy_key: string;
				title: string;
				version_id: string;
				version: string;
				status: string;
				effective_from: string;
				effective_to: string | null;
				section_id: string;
				heading: string;
				body: string;
				content_hash: string;
				policy_family: string;
				product_scope: string;
				jurisdiction: string;
				domain: string;
			}>;
			const candidates: PolicySectionRow[] = rows.map((row) => ({
				policyId: row.policy_id,
				policyKey: row.policy_key,
				title: row.title,
				policyVersionId: row.version_id,
				version: row.version,
				status: (row.status === "retired" ? "retired" : "approved") as "approved" | "retired",
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				sectionId: row.section_id,
				heading: row.heading,
				body: row.body,
				contentHash: row.content_hash,
				policyFamily: row.policy_family,
				productScope: row.product_scope as PolicySectionRow["productScope"],
				jurisdiction: row.jurisdiction,
				domain: row.domain,
			}));
			return selectActiveSection(
				candidates,
				{ policyKey: input.policyKey, sectionId: input.sectionId, versionId: input.versionId },
				{ asOf: input.asOf, productScope: input.productScope, jurisdiction: input.jurisdiction },
			);
		},

		async listVersionSectionIds(versionId) {
			const rows = (await sql`
				SELECT section_id FROM policy_sections
				WHERE version_id = ${versionId}
				ORDER BY order_index
			`) as unknown as Array<{ section_id: string }>;
			return rows.map((row) => row.section_id);
		},

		async listVersionCorpusSections(versionId) {
			const rows = (await sql`
				SELECT d.policy_key, s.section_id, d.product_scope::text AS product_scope
				FROM policy_sections s
				JOIN policy_versions v ON v.id = s.version_id
				JOIN policy_documents d ON d.id = v.policy_id
				WHERE s.version_id = ${versionId}
			`) as unknown as Array<{
				policy_key: string;
				section_id: string;
				product_scope: "individual" | "sme" | "all";
			}>;
			return rows.map((row) => ({
				policyKey: row.policy_key,
				sectionId: row.section_id,
				productScope: row.product_scope,
			}));
		},

		async listApprovedCorpusSections() {
			const rows = (await sql`
				SELECT d.policy_key, s.section_id, d.product_scope::text AS product_scope
				FROM policy_sections s
				JOIN policy_versions v ON v.id = s.version_id
				JOIN policy_documents d ON d.id = v.policy_id
				WHERE v.status = 'approved' AND d.domain = 'credit'
			`) as unknown as Array<{
				policy_key: string;
				section_id: string;
				product_scope: "individual" | "sme" | "all";
			}>;
			return rows.map((row) => ({
				policyKey: row.policy_key,
				sectionId: row.section_id,
				productScope: row.product_scope,
			}));
		},

		async hasVersionChunks(versionId) {
			const active = await store.getActiveIndex();
			if (!active) return false;
			const sections = await store.listVersionSectionIds(versionId);
			if (sections.length === 0) return false;
			const rows = (await sql`
				SELECT count(*)::int AS n
				FROM policy_chunks c
				JOIN policy_sections s
				  ON s.version_id = c.version_id AND s.section_id = c.section_id
				WHERE c.version_id = ${versionId}
				  AND c.index_version = ${active.indexVersion}
				  AND c.content_hash = s.content_hash
			`) as unknown as Array<{ n: number }>;
			return (rows[0]?.n ?? 0) === sections.length;
		},

		async insertQuery(record: PolicyQueryRecord) {
			await sql`
				INSERT INTO policy_queries (
					id, actor_id, actor_role, mode, budget_class, application_id, run_id,
					question_hmac, domain, as_of, status, error_code, retrieved_section_ids, usage_cost
				) VALUES (
					${record.id}, ${record.actorId}, ${record.actorRole}, ${record.mode},
					${record.budgetClass}, ${record.applicationId}, ${record.runId},
					${record.questionHmac}, 'credit', ${record.asOf}::date, ${record.status},
					${record.errorCode}, ${JSON.stringify(record.retrievedSectionIds)}::jsonb,
					${String(record.usageCost)}::numeric
				)
			`;
		},

		async insertCitations(queryId, rows) {
			for (const row of rows) {
				await sql`
					INSERT INTO policy_query_citations (
						query_id, item_ref, segment_index, policy_id, version_id, section_id,
						quote, quote_start, quote_end, content_hash
					) VALUES (
						${queryId}, ${row.itemRef}, ${row.segmentIndex}, ${row.citation.policyId},
						${row.citation.policyVersionId}, ${row.citation.sectionId}, ${row.citation.quote},
						${row.citation.quoteStart}, ${row.citation.quoteEnd}, ${row.citation.contentHash}
					)
				`;
			}
		},

		async consumeCaseToken(jti, runId, applicationId) {
			const rows = (await sql`
				INSERT INTO policy_case_token_uses (jti, run_id, application_id)
				VALUES (${jti}, ${runId}, ${applicationId})
				ON CONFLICT (jti) DO NOTHING
				RETURNING jti
			`) as unknown as Array<{ jti: string }>;
			return rows.length > 0;
		},

		async getVersion(versionId) {
			const rows = (await sql`
				SELECT id, policy_id, status, effective_from::text AS effective_from,
					effective_to::text AS effective_to, submitted_by, created_by_user_id, version
				FROM policy_versions
				WHERE id = ${versionId}
				LIMIT 1
			`) as unknown as Array<{
				id: string;
				policy_id: string;
				status: string;
				effective_from: string;
				effective_to: string | null;
				submitted_by: string | null;
				created_by_user_id: string | null;
				version: string;
			}>;
			const row = rows[0];
			if (!row) return null;
			return {
				id: row.id,
				policyId: row.policy_id,
				status: row.status,
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				submittedBy: row.submitted_by,
				createdByUserId: row.created_by_user_id,
				version: row.version,
			};
		},

		async submitVersion(versionId, actorId) {
			await sql.begin(async (tx) => {
				await tx`
					UPDATE policy_versions
					SET submitted_by = ${actorId}, submitted_at = now()
					WHERE id = ${versionId} AND status = 'draft'
				`;
				await tx`
					INSERT INTO policy_approvals (version_id, actor_id, actor_principal, actor_role, action)
					VALUES (${versionId}, ${actorId}, ${actorId}, 'officer', 'submitted')
				`;
			});
		},

		async approveVersion(versionId, actorId, effectiveFrom) {
			await sql.begin(async (tx) => {
				const rows = (await tx`
					SELECT policy_id FROM policy_versions WHERE id = ${versionId} FOR UPDATE
				`) as unknown as Array<{ policy_id: string }>;
				const policyId = rows[0]?.policy_id;
				if (!policyId) throw new Error("version not found");
				await tx`SELECT id FROM policy_documents WHERE id = ${policyId} FOR UPDATE`;
				const priorEq = (await tx`
					SELECT id FROM policy_versions
					WHERE policy_id = ${policyId} AND status = 'approved'
					  AND id <> ${versionId} AND effective_from = ${effectiveFrom}::date
					LIMIT 1
				`) as unknown as Array<{ id: string }>;
				if (priorEq.length > 0) throw new Error("effective date already used");
				await tx`
					UPDATE policy_versions
					SET effective_to = (${effectiveFrom}::date - 1)
					WHERE policy_id = ${policyId} AND status = 'approved' AND id <> ${versionId}
					  AND effective_from < ${effectiveFrom}::date
					  AND (effective_to IS NULL OR effective_to >= ${effectiveFrom}::date)
				`;
				await tx`
					UPDATE policy_versions
					SET status = 'approved', effective_from = ${effectiveFrom}::date,
						effective_to = NULL, approved_by = ${actorId}, approved_at = now()
					WHERE id = ${versionId} AND status = 'draft'
				`;
				await tx`
					INSERT INTO policy_approvals (version_id, actor_id, actor_principal, actor_role, action)
					VALUES (${versionId}, ${actorId}, ${actorId}, 'officer', 'approved')
				`;
			});
		},

		async retireVersion(versionId, actorId) {
			await sql.begin(async (tx) => {
				const rows = (await tx`
					SELECT id, policy_id, effective_from::text AS effective_from
					FROM policy_versions WHERE id = ${versionId} FOR UPDATE
				`) as unknown as Array<{ id: string; policy_id: string; effective_from: string }>;
				const version = rows[0];
				if (!version) throw new Error("version not found");
				await tx`SELECT id FROM policy_documents WHERE id = ${version.policy_id} FOR UPDATE`;
				const day = new Date().toISOString().slice(0, 10);
				const future = version.effective_from > day;
				const next = (await tx`
					SELECT effective_from::text AS effective_from
					FROM policy_versions
					WHERE policy_id = ${version.policy_id} AND status = 'approved' AND id <> ${versionId}
					  AND effective_from > ${version.effective_from}::date
					ORDER BY effective_from ASC LIMIT 1
				`) as unknown as Array<{ effective_from: string }>;
				const nextFrom = next[0]?.effective_from ?? null;
				await tx`
					UPDATE policy_versions
					SET status = 'retired',
						effective_to = CASE
							WHEN ${future} THEN (${version.effective_from}::date - 1)
							ELSE GREATEST(${day}::date - 1, ${version.effective_from}::date)
						END
					WHERE id = ${versionId}
				`;
				if (future) {
					await tx`
						UPDATE policy_versions
						SET effective_to = ${nextFrom === null ? null : nextFrom}::date
						WHERE policy_id = ${version.policy_id} AND status = 'approved' AND id <> ${versionId}
						  AND effective_from < ${version.effective_from}::date
					`;
				}
				await tx`
					INSERT INTO policy_approvals (version_id, actor_id, actor_principal, actor_role, action)
					VALUES (${versionId}, ${actorId}, ${actorId}, 'officer', 'retired')
				`;
			});
		},

		async reserveBudget(input) {
			return sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.day}:${input.budgetClass}:budget`}))`;
				await tx`
					UPDATE policy_spend_reservations
					SET settled_at = now()
					WHERE settled_at IS NULL AND expires_at < now()
				`;
				const classReserved = (await tx`
					SELECT COALESCE(SUM(amount_usd), 0) AS n
					FROM policy_spend_reservations
					WHERE day = ${input.day}::date AND budget_class = ${input.budgetClass}
					  AND settled_at IS NULL AND expires_at > now()
				`) as unknown as Array<{ n: string }>;
				const classSpent = (await tx`
					SELECT COALESCE(SUM(usage_cost), 0) AS n
					FROM policy_queries
					WHERE created_at::date = ${input.day}::date AND budget_class = ${input.budgetClass}
				`) as unknown as Array<{ n: string }>;
				if (
					num(classReserved[0]?.n) + num(classSpent[0]?.n) + input.maxCostUsd >
					input.dailyCapUsd
				) {
					return { error: "budget_exceeded" as const };
				}
				if (input.actorCapUsd > 0) {
					const actorReserved = (await tx`
						SELECT COALESCE(SUM(amount_usd), 0) AS n
						FROM policy_spend_reservations
						WHERE day = ${input.day}::date AND actor_id = ${input.actorId}
						  AND settled_at IS NULL AND expires_at > now()
					`) as unknown as Array<{ n: string }>;
					const actorSpent = (await tx`
						SELECT COALESCE(SUM(usage_cost), 0) AS n
						FROM policy_queries
						WHERE created_at::date = ${input.day}::date AND actor_id = ${input.actorId}
					`) as unknown as Array<{ n: string }>;
					if (
						num(actorReserved[0]?.n) + num(actorSpent[0]?.n) + input.maxCostUsd >
						input.actorCapUsd
					) {
						return { error: "budget_exceeded" as const };
					}
				}
				const inserted = (await tx`
					INSERT INTO policy_spend_reservations (day, budget_class, actor_id, amount_usd, expires_at)
					VALUES (${input.day}::date, ${input.budgetClass}, ${input.actorId}, ${input.maxCostUsd},
						now() + (${input.ttlSeconds} * INTERVAL '1 second'))
					RETURNING id
				`) as unknown as Array<{ id: string }>;
				return { reservationId: inserted[0]!.id };
			});
		},

		async settleBudget(reservationId, actualCostUsd) {
			// The query row carries the actual cost; settling releases the
			// reservation. Clamp negative model costs to zero.
			void actualCostUsd;
			await sql`
				UPDATE policy_spend_reservations SET settled_at = now() WHERE id = ${reservationId}
			`;
		},
	};
	return store;
}
