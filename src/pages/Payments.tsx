import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, TrendingUp, Clock } from "lucide-react";
import { mockPayouts } from "@/lib/mockData";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import StatsCard from "@/components/StatsCard";

export default function Payments() {
  const totalEarnings = mockPayouts.reduce((sum, payout) => sum + payout.amount, 0);
  const pendingAmount = mockPayouts
    .filter((p) => p.status === "pending")
    .reduce((sum, payout) => sum + payout.amount, 0);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Payments</h2>
          <p className="text-muted-foreground">Track your earnings and payouts</p>
        </div>

        {/* Payment Stats */}
        <div className="grid gap-4 md:grid-cols-3">
          <StatsCard
            title="Total Earnings"
            value={`₹${totalEarnings.toLocaleString()}`}
            change="Last 4 months"
            changeType="neutral"
            icon={DollarSign}
            iconColor="text-success"
          />
          <StatsCard
            title="Pending Payout"
            value={`₹${pendingAmount.toLocaleString()}`}
            change="Expected: 5-7 days"
            changeType="neutral"
            icon={Clock}
            iconColor="text-warning"
          />
          <StatsCard
            title="This Month"
            value="₹24,500"
            change="+15.3% from last month"
            changeType="positive"
            icon={TrendingUp}
            iconColor="text-primary"
          />
        </div>

        {/* Payout History */}
        <Card>
          <CardHeader>
            <CardTitle>Payout History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payout ID</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mockPayouts.map((payout) => (
                    <TableRow key={payout.id}>
                      <TableCell className="font-medium">{payout.id}</TableCell>
                      <TableCell className="font-semibold text-lg">
                        ₹{payout.amount.toLocaleString()}
                      </TableCell>
                      <TableCell>{payout.date}</TableCell>
                      <TableCell>{payout.method}</TableCell>
                      <TableCell>
                        <Badge
                          className={
                            payout.status === "completed"
                              ? "bg-success/10 text-success border-success/20"
                              : "bg-warning/10 text-warning border-warning/20"
                          }
                        >
                          {payout.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Bank Details */}
        <Card>
          <CardHeader>
            <CardTitle>Bank Account Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Account Holder</span>
                <span className="font-medium">Rahul Merchant</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Bank Name</span>
                <span className="font-medium">HDFC Bank</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">Account Number</span>
                <span className="font-medium">******* 4567</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">IFSC Code</span>
                <span className="font-medium">HDFC0001234</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
