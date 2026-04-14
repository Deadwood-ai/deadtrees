import React, { useState, useEffect } from "react";
import { Table, Tag, Typography, Button, Tooltip, Spin, Empty } from "antd";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../hooks/useSupabase";
import { useAuth } from "../hooks/useAuthProvider";
import { ClockCircleOutlined } from "@ant-design/icons";
import { useIsMobile } from "../hooks/useIsMobile";

interface Publication {
  id: number;
  doi: string | null;
  title: string;
  description: string;
  created_at: string;
  datasets: number;
}

const PublicationsTable: React.FC = () => {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [publications, setPublications] = useState<Publication[]>([]);

  const fetchPublications = async () => {
    if (!user) return;

    try {
      setLoading(true);

      // Fetch user's publications
      const { data: publicationsData, error } = await supabase
        .from("data_publication")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // For each publication, count the datasets
      const publicationsWithCount = await Promise.all(
        (publicationsData || []).map(async (pub) => {
          const { count, error: countError } = await supabase
            .from("jt_data_publication_datasets")
            .select("*", { count: "exact", head: true })
            .eq("publication_id", pub.id);

          if (countError) throw countError;

          return {
            ...pub,
            datasets: count || 0,
          };
        }),
      );

      setPublications(publicationsWithCount);
    } catch (error) {
      console.error("Error fetching publications:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPublications();
  }, [user]);

  const columns: ColumnsType<Publication> = [
    {
      title: "Title",
      dataIndex: "title",
      key: "title",
      responsive: ["xs"],
      render: (text: string) => <Typography.Text strong>{text}</Typography.Text>,
    },
    {
      title: "Created",
      dataIndex: "created_at",
      key: "created_at",
      responsive: ["sm"],
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: "Datasets",
      dataIndex: "datasets",
      key: "datasets",
      responsive: ["sm"],
      render: (count: number) => <Tag color="blue">{count}</Tag>,
    },
    {
      title: "Status",
      dataIndex: "doi",
      key: "status",
      responsive: ["xs"],
      render: (doi: string | null) => (doi ? <Tag color="green">Published</Tag> : <Tag color="orange">Pending</Tag>),
    },
    {
      title: "DOI",
      dataIndex: "doi",
      key: "doi",
      responsive: ["xs"],
      render: (doi: string | null) =>
        doi ? (
          <Tooltip title="View publication">
            <Button type="link" href={`https://doi.org/${doi}`} target="_blank">
              <img src={`https://freidata.uni-freiburg.de/badge/DOI/${doi}.svg`} alt="FreiDATA badge" />
            </Button>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">
            <Tag icon={<ClockCircleOutlined />} color="orange">
              in Review
            </Tag>
          </Typography.Text>
        ),
    },
  ];

  if (loading) {
    return <Spin size="large" />;
  }

  if (publications.length === 0) {
    return (
      <Empty
        className="mt-8"
        description={
          <div className="flex flex-col items-center justify-center ">
            <Typography.Title color="gray" level={4}>
              No publications yet
            </Typography.Title>
            <Typography.Paragraph>
              Go to the "My Datasets" tab to select and publish your datasets via FreiDATA.
            </Typography.Paragraph>
          </div>
        }
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <Table
        dataSource={publications}
        columns={columns}
        rowKey="id"
        scroll={{ x: isMobile ? 560 : "max-content" }}
        pagination={{ pageSize: 10 }}
      />
    </div>
  );
};

export default PublicationsTable;
