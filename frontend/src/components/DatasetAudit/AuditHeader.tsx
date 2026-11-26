import { Button, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { IDataset } from "../../types/dataset";
import { useDatasetContributors } from "../../hooks/useDatasetAudit";
import { sanitizeText } from "../../utils/textUtils";

const { Title, Text } = Typography;

interface AuditHeaderProps {
	/** the page: "Audit Review" or "Edits & flags" */
	title: string;
	dataset: IDataset;
	onCancel: () => void;
}

export default function AuditHeader({ title, dataset, onCancel }: AuditHeaderProps) {
	const { data: contributors } = useDatasetContributors();
	const uploadedBy = contributors?.get(dataset.id);
	const location = [dataset.admin_level_3 || dataset.admin_level_2, dataset.admin_level_1]
		.filter(Boolean)
		.join(", ");
	// Uploaders are asked at upload time for the site context auditors need
	// (season, whether leafless crowns are dead, where mortality is expected).
	const additionalInformation = sanitizeText(dataset.additional_information).trim();

	return (
		<div className="flex-shrink-0 border-b border-slate-200 bg-white p-3 shadow-sm">
			<Button shape="circle" onClick={onCancel} icon={<ArrowLeftOutlined />} className="mb-2" />
			<div>
				<Title level={5} className="m-0 text-sm">
					{title}: {dataset.id} - {location}
				</Title>
			</div>
			{additionalInformation && (
				<Text type="secondary" className="mt-2 block text-xs">
					<span className="font-medium">Additional information:</span>{" "}
					<span className="block max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-slate-600">
						{additionalInformation}
					</span>
				</Text>
			)}
			{uploadedBy && (
				<Text type="secondary" className="mt-1 block text-xs font-medium">
					Uploaded by: <span className="text-blue-600">{uploadedBy}</span>
				</Text>
			)}
		</div>
	);
}
