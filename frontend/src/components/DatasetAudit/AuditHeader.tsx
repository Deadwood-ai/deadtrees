import { Button, Typography } from "antd";
import { ArrowLeftOutlined, FileTextOutlined } from "@ant-design/icons";
import { IDataset } from "../../types/dataset";
import { DatasetAuditUserInfo } from "../../hooks/useDatasetAudit";

const { Title, Text } = Typography;

const AUDIT_PROTOCOL_URL = "https://docs.google.com/document/d/1EQ52zDOU6X6ze1g-xKd381IPziv72Pt4QV18YDYqIUo/edit";

interface AuditHeaderProps {
	dataset: IDataset;
	auditData?: DatasetAuditUserInfo | null;
	onCancel: () => void;
}

export default function AuditHeader({ dataset, auditData, onCancel }: AuditHeaderProps) {
	const location = [dataset.admin_level_3 || dataset.admin_level_2, dataset.admin_level_1]
		.filter(Boolean)
		.join(", ");

	return (
		<div className="flex-shrink-0 border-b border-slate-200 bg-white p-3 shadow-sm">
			<Button shape="circle" onClick={onCancel} icon={<ArrowLeftOutlined />} className="mb-2" />
			<div>
				<Title level={5} className="m-0 text-sm">
					Audit: {dataset.id} - {location}
				</Title>
				<a
					href={AUDIT_PROTOCOL_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 hover:underline"
				>
					<FileTextOutlined />
					Audit Protocol
				</a>
			</div>
			{auditData?.uploaded_by_email && (
				<Text type="secondary" className="mt-1 block text-xs font-medium">
					Uploaded by: <span className="text-blue-600">{auditData.uploaded_by_email}</span>
				</Text>
			)}
			{auditData?.audited_by && (
				<Text type="secondary" className="mt-1 block text-xs font-medium text-slate-500">
					Last audited by:{" "}
					<span className="text-blue-600">{auditData.audited_by_email || auditData.audited_by}</span>
				</Text>
			)}
		</div>
	);
}
