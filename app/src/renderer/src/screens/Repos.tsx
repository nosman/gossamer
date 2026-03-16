import React, { useEffect, useState } from "react";
import {
  Box, Text, Group, Button, TextInput, Stack, Badge, ActionIcon,
  Table, Alert, Loader, Center, Divider, Modal,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { fetchRepos, fetchCurrentRepo, addRepo, deleteRepo, type RepoConfig } from "../api";

export function Repos() {
  const [repos, setRepos]           = useState<RepoConfig[]>([]);
  const [current, setCurrent]       = useState<RepoConfig | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RepoConfig | null>(null);

  const [modalOpen, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [form, setForm] = useState({ name: "", remote: "", localPath: "" });
  const [formError, setFormError]   = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      const [r, c] = await Promise.all([fetchRepos(), fetchCurrentRepo()]);
      setRepos(r);
      setCurrent(c);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleAdd = async () => {
    if (!form.name.trim() || !form.localPath.trim()) {
      setFormError("Name and local path are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await addRepo({ name: form.name.trim(), remote: form.remote.trim(), localPath: form.localPath.trim() });
      setForm({ name: "", remote: "", localPath: "" });
      closeModal();
      await load();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (repo: RepoConfig) => {
    try {
      await deleteRepo(repo.localPath);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading) {
    return <Center h={200}><Loader size="sm" /></Center>;
  }

  return (
    <Box p="md" style={{ maxWidth: 800 }}>
      <Group justify="space-between" mb="md">
        <Text fw={600} size="lg">Repositories</Text>
        <Button size="xs" onClick={openModal}>Add repo</Button>
      </Group>

      {error && (
        <Alert color="red" mb="md">{error}</Alert>
      )}

      {repos.length === 0 ? (
        <Text c="dimmed" size="sm">No repositories configured. Add one to get started.</Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Local path</Table.Th>
              <Table.Th>Remote</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {repos.map((repo) => {
              const isCurrent = current?.localPath === repo.localPath;
              return (
                <Table.Tr key={repo.localPath}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text size="sm" fw={500}>{repo.name}</Text>
                      {isCurrent && <Badge size="xs" color="indigo">current</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" ff="monospace">{repo.localPath}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" ff="monospace">{repo.remote || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      disabled={isCurrent}
                      title={isCurrent ? "Cannot remove the active repo" : "Remove"}
                      onClick={() => setDeleteTarget(repo)}
                    >
                      ✕
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      {/* Add repo modal */}
      <Modal opened={modalOpen} onClose={closeModal} title="Add repository" size="sm">
        <Stack gap="sm">
          <TextInput
            label="Name"
            placeholder="my-project"
            value={form.name}
            onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, name: v })); }}
            required
          />
          <TextInput
            label="Local path"
            placeholder="/Users/you/projects/my-project"
            value={form.localPath}
            onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, localPath: v })); }}
            required
          />
          <TextInput
            label="Remote URL"
            placeholder="git@github.com:you/my-project.git"
            value={form.remote}
            onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, remote: v })); }}
          />
          {formError && <Alert color="red" size="xs">{formError}</Alert>}
          <Divider />
          <Group justify="flex-end">
            <Button variant="subtle" size="xs" onClick={closeModal} disabled={submitting}>Cancel</Button>
            <Button size="xs" onClick={handleAdd} loading={submitting}>Add</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remove repository"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            Remove <Text span fw={600}>{deleteTarget?.name}</Text> from Gossamer?
            This only removes it from the config — the local files and database are not deleted.
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" size="xs" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button size="xs" color="red" onClick={() => deleteTarget && handleDelete(deleteTarget)}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
