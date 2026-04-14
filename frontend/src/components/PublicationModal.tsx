import React, { useState, useEffect } from "react";
import { Modal, Form, Input, Button, Typography, Table, Spin, message, Tag, Row, Col, Space } from "antd";
import { PlusOutlined, DeleteOutlined, SearchOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { supabase } from "../hooks/useSupabase";
import { useAuth } from "../hooks/useAuthProvider";
import { processOrcidInput } from "../utils/orcidUtils";
import { palette } from "../theme/palette";

interface Author {
  id?: number;
  first_name: string;
  last_name: string;
  organisation: string;
  orcid?: string;
  title?: string;
}

interface DatasetType {
  id: number;
  file_name: string;
  platform?: string;
  aquisition_year?: number;
  aquisition_day?: number;
  aquisition_month?: number;
  admin_level_1?: string;
  admin_level_2?: string;
  admin_level_3?: string;
}

interface PublicationModalProps {
  visible: boolean;
  onCancel: () => void;
  datasets: DatasetType[];
  onSuccess?: () => void;
}

const PublicationModal: React.FC<PublicationModalProps> = ({ visible, onCancel, datasets, onSuccess }) => {
  const [form] = Form.useForm();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [orcidLoading, setOrcidLoading] = useState(false);
  const [currentOrcid, setCurrentOrcid] = useState("");

  // Generate title based on datasets
  useEffect(() => {
    if (visible && datasets.length > 0) {
      // 1. Get the most frequent admin levels
      const adminLevel1Map = new Map<string, number>();
      const adminLevel2Or3Map = new Map<string, number>();

      datasets.forEach((dataset) => {
        if (dataset.admin_level_1) {
          adminLevel1Map.set(dataset.admin_level_1, (adminLevel1Map.get(dataset.admin_level_1) || 0) + 1);
        }

        const level2Or3 = dataset.admin_level_3 || dataset.admin_level_2;
        if (level2Or3) {
          adminLevel2Or3Map.set(level2Or3, (adminLevel2Or3Map.get(level2Or3) || 0) + 1);
        }
      });

      // 2. Find most frequent values
      let mostFrequentAdmin1 = "";
      let maxAdmin1Count = 0;
      adminLevel1Map.forEach((count, level) => {
        if (count > maxAdmin1Count) {
          mostFrequentAdmin1 = level;
          maxAdmin1Count = count;
        }
      });

      let mostFrequentAdmin2Or3 = "";
      let maxAdmin2Or3Count = 0;
      adminLevel2Or3Map.forEach((count, level) => {
        if (count > maxAdmin2Or3Count) {
          mostFrequentAdmin2Or3 = level;
          maxAdmin2Or3Count = count;
        }
      });

      // 3. Format author names
      const authorNames = authors.map((author) => `${author.first_name} ${author.last_name}`).join(", ");

      // 4. Create title
      let title = "";
      if (mostFrequentAdmin2Or3 && mostFrequentAdmin1) {
        title = `${mostFrequentAdmin2Or3}, ${mostFrequentAdmin1}`;

        if (authorNames) {
          title += ` by ${authorNames}`;
        }

        title += " - part of deadtrees.earth";
      } else {
        title = "New submission";

        if (authorNames) {
          title += ` by ${authorNames}`;
        }

        title += " - part of deadtrees.earth";
      }

      // Set the form field
      form.setFieldsValue({ title });
    }
  }, [visible, datasets, authors, form]);

  const fetchOrcidInfo = async () => {
    const { orcidId, isValid, error } = processOrcidInput(currentOrcid);

    if (!isValid || !orcidId) {
      message.error(error || "Please enter a valid ORCID ID");
      return;
    }

    setOrcidLoading(true);
    try {
      const response = await fetch(`https://pub.orcid.org/v3.0/${orcidId}`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch ORCID information");
      }

      const data = await response.json();
      console.debug("ORCID data:", data);

      // Extract relevant information from ORCID response
      const firstName = data.person?.name?.["given-names"]?.value || "";
      const lastName = data.person?.name?.["family-name"]?.value || "";

      // Extract organization from employments
      let organisation = "";
      const employmentGroups = data["activities-summary"]?.employments?.["affiliation-group"] || [];

      if (employmentGroups.length > 0 && employmentGroups[0].summaries?.length > 0) {
        const employment = employmentGroups[0].summaries[0]["employment-summary"];
        if (employment && employment.organization) {
          organisation = employment.organization.name || "";
        }

        // Fallback to department name if available
        if (!organisation && employment && employment["department-name"]) {
          organisation = employment["department-name"];
        }
      }

      // Add new author at the beginning of the list
      const newAuthors = [
        {
          first_name: firstName,
          last_name: lastName,
          organisation,
          orcid: orcidId,
        },
        ...authors,
      ];

      setAuthors(newAuthors);
      setCurrentOrcid("");

      // Regenerate title with new author
      if (visible && datasets.length > 0) {
        const adminLevel1 = datasets[0].admin_level_1 || "";
        const adminLevel2Or3 = datasets[0].admin_level_3 || datasets[0].admin_level_2 || "";

        const authorNames = newAuthors.map((author) => `${author.first_name} ${author.last_name}`).join(", ");

        let title = "";
        if (adminLevel2Or3 && adminLevel1) {
          title = `${adminLevel2Or3}, ${adminLevel1}`;

          if (authorNames) {
            title += ` by ${authorNames}`;
          }

          title += " - part of deadtrees.earth";
        } else {
          title = "New submission";

          if (authorNames) {
            title += ` by ${authorNames}`;
          }

          title += " - part of deadtrees.earth";
        }

        // Set the form field
        form.setFieldsValue({ title });
      }
    } catch (error) {
      console.error("Error fetching ORCID data:", error);
      message.error("Failed to fetch information from ORCID");
    } finally {
      setOrcidLoading(false);
    }
  };

  const addEmptyAuthor = () => {
    // Add empty author at the beginning of the list
    setAuthors([{ first_name: "", last_name: "", organisation: "" }, ...authors]);
  };

  const removeAuthor = (index: number) => {
    const newAuthors = [...authors];
    newAuthors.splice(index, 1);
    setAuthors(newAuthors);
  };

  const updateAuthor = (index: number, field: keyof Author, value: string) => {
    const newAuthors = [...authors];
    newAuthors[index] = { ...newAuthors[index], [field]: value };
    setAuthors(newAuthors);

    // Update title when author names change
    if (field === "first_name" || field === "last_name") {
      if (visible && datasets.length > 0) {
        const adminLevel1 = datasets[0].admin_level_1 || "";
        const adminLevel2Or3 = datasets[0].admin_level_3 || datasets[0].admin_level_2 || "";

        const authorNames = newAuthors.map((author) => `${author.first_name} ${author.last_name}`).join(", ");

        let title = "";
        if (adminLevel2Or3 && adminLevel1) {
          title = `${adminLevel2Or3}, ${adminLevel1}`;

          if (authorNames) {
            title += ` by ${authorNames}`;
          }

          title += " - part of deadtrees.earth";
        } else {
          title = "New submission";

          if (authorNames) {
            title += ` by ${authorNames}`;
          }

          title += " - part of deadtrees.earth";
        }

        // Set the form field
        form.setFieldsValue({ title });
      }
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      if (authors.length === 0) {
        message.error("Please add at least one author");
        return;
      }

      // Validate all authors have at least first name, last name, and organisation
      const invalidAuthors = authors.some((author) => !author.first_name || !author.last_name || !author.organisation);

      if (invalidAuthors) {
        message.error("All authors must have a first name, last name, and organisation");
        return;
      }

      setLoading(true);

      // Step 1: Create publication record
      const { data: publicationData, error: publicationError } = await supabase
        .from("data_publication")
        .insert({
          title: values.title,
          description: values.description,
          user_id: user?.id,
        })
        .select()
        .single();

      if (publicationError || !publicationData) {
        throw publicationError || new Error("Failed to create publication");
      }

      // Step 2: Create author records and link them
      for (const author of authors) {
        // Create author record
        const { data: authorData, error: authorError } = await supabase
          .from("user_info")
          .insert({
            first_name: author.first_name,
            last_name: author.last_name,
            organisation: author.organisation,
            orcid: author.orcid,
            title: author.title,
            user: user?.id,
          })
          .select()
          .single();

        if (authorError || !authorData) {
          throw authorError || new Error("Failed to create author");
        }

        // Link author to publication
        const { error: linkError } = await supabase.from("jt_data_publication_user_info").insert({
          publication_id: publicationData.id,
          user_info_id: authorData.id,
        });

        if (linkError) {
          throw linkError;
        }
      }

      // Step 3: Link datasets to publication
      for (const dataset of datasets) {
        const { error: datasetLinkError } = await supabase.from("jt_data_publication_datasets").insert({
          publication_id: publicationData.id,
          dataset_id: dataset.id,
        });

        if (datasetLinkError) {
          throw datasetLinkError;
        }
      }

      message.success("Publication submitted successfully");

      // Call the onSuccess callback if provided
      if (onSuccess) {
        onSuccess();
      } else {
        onCancel(); // Fallback to just closing the modal
      }
    } catch (error) {
      console.error("Error submitting publication:", error);
      message.error("Failed to submit publication");
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", key: "id" },
    { title: "File Name", dataIndex: "file_name", key: "file_name" },
    {
      title: "Location",
      dataIndex: "id",
      key: "id",
      render: (tag: number) => {
        if (datasets?.find((d) => d.id === tag)?.admin_level_1) {
          return (
            <Tag color="green">
              {datasets?.find((d) => d.id === tag)?.admin_level_1},{" "}
              {datasets?.find((d) => d.id === tag)?.admin_level_3 || datasets?.find((d) => d.id === tag)?.admin_level_2}
            </Tag>
          );
        } else {
          return <Tag icon={<ClockCircleOutlined />} color="default"></Tag>;
        }
      },
    },
    {
      title: "Date",
      dataIndex: "aquisition_day",
      key: "aquisition_day",
      render: (_: unknown, record: DatasetType) => (
        <span>
          {record.aquisition_day && record.aquisition_day + "/"}
          {record.aquisition_month && record.aquisition_month + "/"}
          {record.aquisition_year}
        </span>
      ),
    },
  ];

  return (
    <Modal
      title="Publish Datasets to FreiDATA"
      open={visible}
      onCancel={onCancel}
      width={800}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          Cancel
        </Button>,
        <Button key="submit" type="primary" loading={loading} onClick={handleSubmit}>
          Submit Publication
        </Button>,
      ]}
    >
      <Spin spinning={loading}>
        <Typography.Title level={5}>Selected Datasets ({datasets.length})</Typography.Title>
        <Table
          dataSource={datasets}
          columns={columns}
          pagination={false}
          size="small"
          rowKey="id"
          style={{ marginBottom: 24 }}
        />

        <Form form={form} layout="vertical">
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            Authors
          </Typography.Title>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={14}>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  placeholder="Enter ORCID ID or URL (e.g., 0000-0002-1825-0097 or https://orcid.org/0000-0002-1825-0097)"
                  value={currentOrcid}
                  onChange={(e) => setCurrentOrcid(e.target.value)}
                />
                <Button type="primary" icon={<SearchOutlined />} onClick={fetchOrcidInfo} loading={orcidLoading}>
                  Lookup
                </Button>
              </Space.Compact>
            </Col>
            <Col span={10}>
              <Button type="dashed" icon={<PlusOutlined />} onClick={addEmptyAuthor} style={{ width: "100%" }}>
                Add Author Manually
              </Button>
            </Col>
          </Row>

          {authors.map((author, index) => (
            <div
              key={index}
              style={{ marginBottom: 16, padding: 16, border: `1px solid ${palette.neutral[100]}`, borderRadius: 4 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <Typography.Text strong>Author {index + 1}</Typography.Text>
                  {author.orcid && (
                    <Button
                      className="ml-4 p-2"
                      href={`https://orcid.org/${author.orcid}`}
                      target="_blank"
                      size="small"
                    >
                      {author.orcid}
                    </Button>
                  )}
                </div>
                <Button danger icon={<DeleteOutlined />} onClick={() => removeAuthor(index)} size="small">
                  Remove
                </Button>
              </div>

              <Row gutter={16}>
                <Col span={7}>
                  <Input
                    placeholder="First Name"
                    value={author.first_name}
                    onChange={(e) => updateAuthor(index, "first_name", e.target.value)}
                  />
                </Col>
                <Col span={7}>
                  <Input
                    placeholder="Last Name"
                    value={author.last_name}
                    onChange={(e) => updateAuthor(index, "last_name", e.target.value)}
                  />
                </Col>
                <Col span={10}>
                  <Input
                    placeholder="Organisation"
                    value={author.organisation}
                    onChange={(e) => updateAuthor(index, "organisation", e.target.value)}
                  />
                </Col>
              </Row>
            </div>
          ))}

          <Form.Item
            label="Description"
            name="description"
            rules={[{ required: true, message: "Please provide a description" }]}
          >
            <Input.TextArea rows={4} placeholder="Describe your dataset collection, methodology, and purpose" />
          </Form.Item>

          <Form.Item
            label="Publication Title (Auto-generated)"
            name="title"
            rules={[{ required: true, message: "Please enter a title for this publication" }]}
          >
            <Input disabled style={{ fontWeight: "bold" }} />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
};

export default PublicationModal;
