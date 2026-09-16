resource "aws_iam_role" "this" {
  name                 = "${var.name}-role"
  permissions_boundary = var.boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "this" {
  name = "${var.name}-inline"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = aws_sqs_queue.work.arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/service/${var.name}"
  retention_in_days = 14
  kms_key_id        = var.log_kms_key_arn
}

resource "aws_sqs_queue" "work" {
  name                       = "${var.name}-work"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "dead" {
  name = "${var.name}-dead"
}

resource "aws_security_group" "task" {
  name        = "${var.name}-task"
  description = "Egress only; the task reaches the queue and the log group."

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
