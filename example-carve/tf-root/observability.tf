# The free first move. Nothing references it and it references nothing, so the
# advisor scores it 100 — a clean tier-1 map with an empty boundary. The
# walkthrough names it and then carves the bucket instead: there is always a
# zero-cost resource to start with, and starting there proves nothing more than
# that the machinery runs.
#
# (The API lambda's own log group is not here any more — it was carved into
# ../app/src/carved.ts last month.)

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/acme/platform/worker"
  retention_in_days = 30

  tags = {
    Name      = "acme-platform-worker"
    Component = "worker"
  }
}
